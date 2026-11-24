import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The client of a history entry as columns (review wave 1b, group "feed", DB-9).
 *
 *  - event.company_id and event.contact_id (nullable, ON DELETE SET NULL) with an index each by time:
 *    the feeds of a company and a contact query them instead of looking into the JSON snapshots
 *    (after_state -> 'data' -> 'company' ->> 'id'). New rows get them from EventClientSubscriber; the
 *    rows written before get them here by the same rules:
 *      contact: the contact the snapshot names (added to the deal, the task's contact), the task's
 *               contact, the client among the author and the addressee;
 *      company: the deal's company, the task's company, the one the snapshot names, the contact's.
 *    Ids of snapshots that point to rows deleted since are left out.
 *  - SALE-16: the rights, goals, messenger ids, password hashes and token versions of employees out of
 *    every snapshot (FeedHistory1795210000000 cleaned only data.agent / data.created_by of deals and
 *    tasks; deeper ones — the deal of a task, the creator of a contact — and other types stayed).
 *    The feeds strip them on reading too (events/feed-privacy.ts).
 */
export class EventClient1795610000000 implements MigrationInterface {
  name = 'EventClient1795610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "company_id" integer NULL`);
    await queryRunner.query(`ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "contact_id" integer NULL`);

    // an int id of a snapshot, or null
    const id = (path: string) =>
      `CASE WHEN jsonb_typeof(e.after_state -> 'data') = 'object' AND (${path}) ~ '^[0-9]{1,9}$' THEN (${path})::int END`;
    const data = `(e.after_state -> 'data')`;
    const snapshotContact = `CASE
        WHEN e.type = 1 THEN ${id(`${data} ->> 'id'`)}
        WHEN e.type IN (6, 7, 17) AND jsonb_typeof(${data} -> 'ctr_agent') = 'object' THEN ${id(`(${data} -> 'ctr_agent') ->> 'id'`)}
      END`;
    const snapshotCompany = `CASE
        WHEN e.type = 2 THEN ${id(`${data} ->> 'id'`)}
        WHEN e.type IN (1, 6, 7, 17) AND jsonb_typeof(${data} -> 'company') = 'object' THEN ${id(`(${data} -> 'company') ->> 'id'`)}
      END`;

    await queryRunner.query(`
      UPDATE "event" e
         SET contact_id = COALESCE(
               (SELECT u.id FROM "user" u WHERE u.id = ${snapshotContact} AND u.role = 'ctr_agent'),
               (SELECT t.ctr_agent_id FROM "task" t WHERE t.id = e.task_id),
               (SELECT u.id FROM "user" u WHERE u.id = e.user_id AND u.role = 'ctr_agent'),
               (SELECT u.id FROM "user" u WHERE u.id = e.target_user_id AND u.role = 'ctr_agent'))
       WHERE e.contact_id IS NULL
    `);
    await queryRunner.query(`
      UPDATE "event" e
         SET company_id = COALESCE(
               (SELECT d.company_id FROM "deal" d WHERE d.id = e.deal_id),
               (SELECT t.company_id FROM "task" t WHERE t.id = e.task_id),
               (SELECT co.id FROM "company" co WHERE co.id = ${snapshotCompany}),
               (SELECT u.company_id FROM "user" u WHERE u.id = e.contact_id))
       WHERE e.company_id IS NULL
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_event_company') THEN
          ALTER TABLE "event" ADD CONSTRAINT "FK_event_company" FOREIGN KEY ("company_id")
            REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_event_contact') THEN
          ALTER TABLE "event" ADD CONSTRAINT "FK_event_contact" FOREIGN KEY ("contact_id")
            REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_event_company_created" ON "event" ("company_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_event_contact_created" ON "event" ("contact_id", "created_at")`);

    // SALE-16: employees in the snapshots are who they were, not their accounts
    const rows: { id: number; after_state: any; before_state: any }[] = await queryRunner.query(`
      SELECT id, after_state, before_state FROM "event"
       WHERE after_state::text ~ '"(permissions|objectives|token_version|password|refresh_token)"'
          OR before_state::text ~ '"(permissions|objectives|token_version|password|refresh_token)"'
    `);
    for (const row of rows) {
      await queryRunner.query(`UPDATE "event" SET after_state = $2, before_state = $3 WHERE id = $1`, [
        row.id,
        row.after_state === null ? null : JSON.stringify(EventClient1795610000000.strip(row.after_state)),
        row.before_state === null ? null : JSON.stringify(EventClient1795610000000.strip(row.before_state)),
      ]);
    }
  }

  /** The same rule as events/feed-privacy.ts (kept here: a migration must not change with the code). */
  private static strip(value: any): any {
    if (Array.isArray(value)) return value.map((item) => EventClient1795610000000.strip(item));
    if (!value || typeof value !== 'object') return value;
    const staff =
      'permissions' in value || 'objectives' in value || 'token_version' in value ||
      (typeof value.role === 'string' && value.role !== 'ctr_agent' && 'username' in value);
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      if (['permissions', 'objectives', 'token_version', 'password', 'refresh_token'].includes(key)) continue;
      if (staff && ['tg_id', 'wa_id'].includes(key)) continue;
      out[key] = EventClient1795610000000.strip(item);
    }
    return out;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_contact_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_company_created"`);
    await queryRunner.query(`ALTER TABLE "event" DROP CONSTRAINT IF EXISTS "FK_event_contact"`);
    await queryRunner.query(`ALTER TABLE "event" DROP CONSTRAINT IF EXISTS "FK_event_company"`);
    await queryRunner.query(`ALTER TABLE "event" DROP COLUMN IF EXISTS "contact_id"`);
    await queryRunner.query(`ALTER TABLE "event" DROP COLUMN IF EXISTS "company_id"`);
    // the snapshots stay without the employees' rights: nothing to restore
  }
}
