import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The journal «кто что изменил» (src/audit, AUDIT-1…4, 11, 13, 14, 16, ACL-10, TASK-5, TRG-5, CALL-12,
 * DEAL-4, WA-16).
 *  - audit_log: one row per object per operation — who (id and the name of that moment), from where
 *    (web, bot, trigger, autopilot, …), the save group (batch), {column: [old, new]} and the whole
 *    object before and after (no secrets), the deal / company / contact it belongs to. No foreign keys:
 *    a row outlives what it is about.
 *  - Immutable: the trigger audit_log_guard refuses UPDATE, and DELETE unless the session switch
 *    parisa.audit_purge is on (only the nightly cleanup by AUDIT_RETENTION_DAYS sets it).
 *  - event.source / event.source_ref: where a history entry came from (web, bot, trigger, autopilot, …;
 *    "trigger:42"), set on insert from the request context (TRG-5); null for the older rows.
 *  - Baseline: the state of every tracked object at this moment (action 'baseline', batch of zeros
 *    ending in 1), so the history of an object starts from what it was when the journal came, and
 *    that is not shown as news. Secrets are left out here as in the application (passwords, hashes,
 *    tokens, signatures, the names of files on the disk); long texts are shortened.
 * Idempotent; runs on the production data as it is (a few hundred rows of baseline).
 */
const BASELINE_BATCH = '00000000-0000-0000-0000-000000000001';

const BASELINE: { entity: string; table: string; state: string; title: string; deal?: string; company?: string; contact?: string }[] = [
  {
    entity: 'deal',
    table: 'deal',
    state: `to_jsonb(t) || jsonb_build_object('contacts', ARRAY(SELECT du."userId" FROM deal_user du WHERE du."dealId" = t.id ORDER BY 1))`,
    title: `'Сделка №' || COALESCE(t.display_id::text, t.id::text) || COALESCE(' «' || t.label || '»', '')`,
    deal: 't.id',
    company: 't.company_id',
  },
  { entity: 'deal_product', table: 'deal_product', state: 'to_jsonb(t)', title: `'Товар в сделке'`, deal: 't.deal_id' },
  { entity: 'deal_filler', table: 'deal_filler', state: 'to_jsonb(t)', title: `'Доп. поле сделки'`, deal: 't.deal_id' },
  {
    entity: 'company',
    table: 'company',
    state: 'to_jsonb(t)',
    title: `'Компания «' || COALESCE(t.name, '') || '»'`,
    company: 't.id',
  },
  { entity: 'company_filler', table: 'company_filler', state: 'to_jsonb(t)', title: `'Доп. поле компании'`, company: 't.company_id' },
  {
    // staff accounts and contacts of clients live in one table
    entity: `CASE WHEN t.role = 'ctr_agent' THEN 'contact' ELSE 'user' END`,
    table: 'user',
    state: `to_jsonb(t) - 'password' - 'tg_api_hash' - 'tg_api_id' - 'sign' - 'token_version'`,
    title: `CASE WHEN t.role = 'ctr_agent' THEN 'Контакт' ELSE 'Сотрудник' END || ' «' || COALESCE(t.username, '') || '»'`,
    company: `CASE WHEN t.role = 'ctr_agent' THEN t.company_id END`,
    contact: `CASE WHEN t.role = 'ctr_agent' THEN t.id END`,
  },
  { entity: 'user_filler', table: 'user_filler', state: 'to_jsonb(t)', title: `'Доп. поле контакта'`, contact: 't.user_id' },
  {
    entity: 'task',
    table: 'task',
    state: `to_jsonb(t) || jsonb_build_object('result', left(t.result, 300))`,
    title: `'Задача «' || COALESCE(t.label, '') || '»'`,
    deal: 't.deal_id',
    company: 't.company_id',
    contact: 't.ctr_agent_id',
  },
  { entity: 'product', table: 'product', state: 'to_jsonb(t)', title: `'Товар «' || COALESCE(t.name, '') || '»'` },
  { entity: 'product_filler', table: 'product_filler', state: 'to_jsonb(t)', title: `'Доп. поле товара'` },
  {
    entity: 'file',
    table: 'file',
    state: `(to_jsonb(t) - 'path') || jsonb_build_object('deals', ARRAY(SELECT df."dealId" FROM deal_file df WHERE df."fileId" = t.id ORDER BY 1))`,
    title: `'Файл «' || COALESCE(t.name, '') || '»'`,
    deal: `(SELECT min(df."dealId") FROM deal_file df WHERE df."fileId" = t.id)`,
  },
  { entity: 'trigger', table: 'trigger', state: 'to_jsonb(t)', title: `'Триггер №' || t.id` },
  { entity: 'setting', table: 'setting', state: `to_jsonb(t) - 'mail_signature'`, title: `'Общие настройки'` },
  { entity: 'stage', table: 'deal_stage', state: 'to_jsonb(t)', title: `'Этап «' || COALESCE(t.name, '') || '»'` },
  { entity: 'pipeline', table: 'collection', state: 'to_jsonb(t)', title: `'Воронка «' || COALESCE(t.name, '') || '»'` },
  { entity: 'group', table: 'group', state: 'to_jsonb(t)', title: `'Группа «' || COALESCE(t.name, '') || '»'` },
  { entity: 'task_type', table: 'task_type', state: 'to_jsonb(t)', title: `'Тип задачи «' || COALESCE(t.name, '') || '»'` },
  { entity: 'filler', table: 'filler', state: 'to_jsonb(t)', title: `'Доп. поле «' || COALESCE(t.field, '') || '»'` },
  {
    entity: 'mail_template',
    table: 'email_template',
    state: `to_jsonb(t) || jsonb_build_object('template_body', left(t.template_body, 300))`,
    title: `'Шаблон письма «' || COALESCE(t.name, '') || '»'`,
  },
  {
    entity: 'mailbox',
    table: 'email_transporter',
    state: `to_jsonb(t) - 'password'`,
    title: `'Почтовый ящик ' || COALESCE(t.email, '')`,
  },
  { entity: 'recorder_token', table: 'recorder_token', state: `to_jsonb(t) - 'token_hash'`, title: `'Токен записи звонков'` },
  { entity: 'bot_account', table: 'bot_account', state: 'to_jsonb(t)', title: `'Telegram-бот CRM'` },
];

export class AuditLog1795810000000 implements MigrationInterface {
  name = 'AuditLog1795810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_log" (
        "id" BIGSERIAL NOT NULL,
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "batch" character varying(36) NOT NULL,
        "request_id" character varying(64),
        "actor_id" integer,
        "actor_name" character varying(255),
        "source" character varying(16) NOT NULL DEFAULT 'system',
        "source_ref" character varying(64),
        "entity" character varying(32) NOT NULL,
        "entity_id" bigint,
        "action" character varying(16) NOT NULL,
        "changes" jsonb,
        "before_state" jsonb,
        "after_state" jsonb,
        "summary" text,
        "deal_id" integer,
        "company_id" integer,
        "contact_id" integer,
        "meta" jsonb,
        CONSTRAINT "PK_audit_log" PRIMARY KEY ("id")
      )
    `);
    // the history of one object, of a deal / company / contact card, of an author, the journal page
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_log_entity" ON "audit_log" ("entity", "entity_id", "at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_log_deal" ON "audit_log" ("deal_id", "at") WHERE "deal_id" IS NOT NULL`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_log_company" ON "audit_log" ("company_id", "at") WHERE "company_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_log_contact" ON "audit_log" ("contact_id", "at") WHERE "contact_id" IS NOT NULL`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_log_actor" ON "audit_log" ("actor_id", "at") WHERE "actor_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_log_at" ON "audit_log" ("at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_log_batch" ON "audit_log" ("batch")`);

    // immutable: no UPDATE ever; DELETE only by the cleanup of old rows (SET LOCAL parisa.audit_purge = 'on')
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'audit_log: журнал изменений нельзя редактировать';
        END IF;
        IF COALESCE(current_setting('parisa.audit_purge', true), '') <> 'on' THEN
          RAISE EXCEPTION 'audit_log: записи журнала удаляет только очистка по сроку хранения';
        END IF;
        RETURN OLD;
      END $$
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS "audit_log_guard" ON "audit_log"`);
    await queryRunner.query(
      `CREATE TRIGGER "audit_log_guard" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_guard()`,
    );

    // where a history entry came from (TRG-5): web, bot, trigger, autopilot, … and "trigger:42"
    await queryRunner.query(`ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "source" character varying(16)`);
    await queryRunner.query(`ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "source_ref" character varying(64)`);

    // the baseline, once
    const done = await queryRunner.query(`SELECT 1 FROM "audit_log" WHERE "action" = 'baseline' LIMIT 1`);
    if (done.length) return;
    for (const item of BASELINE) {
      const exists = await queryRunner.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`,
        [item.table],
      );
      if (!exists.length) continue;
      await queryRunner.query(`
        INSERT INTO "audit_log" ("at", "batch", "actor_name", "source", "source_ref", "entity", "entity_id", "action",
                                 "after_state", "summary", "deal_id", "company_id", "contact_id")
        SELECT now(), '${BASELINE_BATCH}', NULL, 'system', 'baseline', ${item.entity.startsWith('CASE') ? item.entity : `'${item.entity}'`},
               t."${item.table === 'bot_account' ? 'user_id' : 'id'}", 'baseline', ${item.state},
               'Состояние на момент включения журнала: ' || ${item.title},
               ${item.deal ?? 'NULL'}, ${item.company ?? 'NULL'}, ${item.contact ?? 'NULL'}
          FROM "${item.table}" t
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event" DROP COLUMN IF EXISTS "source_ref"`);
    await queryRunner.query(`ALTER TABLE "event" DROP COLUMN IF EXISTS "source"`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS "audit_log_guard" ON "audit_log"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_log_guard()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log"`);
  }
}
