import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the queries that scan whole tables today (found by reading every WHERE / ORDER BY):
 * the manager control report and «клиент ждёт ответа» (chat events of a deal), deal lists and
 * dashboards (open deals, dates), task reminders (open tasks of a manager), mail sync (mailbox +
 * message id, address lookups).
 */
export class PerfIndexes1795130000000 implements MigrationInterface {
  name = 'PerfIndexes1795130000000';

  private readonly indexes: [string, string][] = [
    ['IDX_event_type_created', `"event" ("type", "created_at")`],
    ['IDX_event_chat_deal', `"event" ("deal_id", "created_at") WHERE "type" IN (9, 11, 12, 16)`],
    ['IDX_event_chat_unreplied', `"event" ("created_at") WHERE "type" IN (9, 11, 12, 16) AND NOT "outgoing" AND "replied_at" IS NULL`],
    ['IDX_event_deal_tg_message', `"event" ("deal_id", "tg_message_id") WHERE "tg_message_id" IS NOT NULL`],
    ['IDX_deal_created', `"deal" ("created_at")`],
    ['IDX_deal_closed', `"deal" ("closed_at") WHERE "closed_at" IS NOT NULL`],
    ['IDX_deal_open_stage', `"deal" ("stage_id") WHERE "deleted_at" IS NULL AND "closed_at" IS NULL`],
    ['IDX_deal_created_by', `"deal" ("created_by")`],
    ['IDX_task_open_agent', `"task" ("agent_id", "end_time") WHERE "closed_at" IS NULL`],
    ['IDX_task_open_deal', `"task" ("deal_id") WHERE "closed_at" IS NULL`],
    ['IDX_task_created', `"task" ("created_at")`],
    ['IDX_email_mailbox_uid', `"email" ("from_mailbox", "email_id")`],
    ['IDX_email_mailbox_sent', `"email" ("from_mailbox", "sent_at")`],
    ['IDX_email_user', `"email" ("user_id")`],
    ['IDX_user_email_lower', `"user" (lower("email"))`],
    ['IDX_user_group', `"user" ("group_id")`],
    ['IDX_recording_created', `"recording" ("created_at")`],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, on] of this.indexes) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON ${on}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of this.indexes) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    }
  }
}
