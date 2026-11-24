import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Triggers as business processes (src/trigger/trigger.service.ts):
 *  - trigger.position: the order of the triggers of a stage. They run in it (a «сменить ответственного»
 *    put first hands the task of the next trigger to the new responsible), the settings page shows it
 *    and lets the admin change it. The triggers saved before keep the order they ran in (by id).
 *  - trigger_run.run_key + the unique partial index IDX_trigger_run_key (trigger_id, deal_id, run_key):
 *    one execution per entry into a stage, per delayed run of a stay, per occurrence of a schedule, per
 *    message and per unanswered client message. Two requests or two API processes that would execute
 *    the same thing cannot both insert the row: exactly once. Old rows have no key (NULL).
 */
export class TriggerProcesses1795690000000 implements MigrationInterface {
  name = 'TriggerProcesses1795690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trigger" ADD COLUMN IF NOT EXISTS "position" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`
      UPDATE "trigger" t SET "position" = x.rn
        FROM (SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "deal_stage_id" ORDER BY "id") - 1)::int AS rn FROM "trigger") x
       WHERE x."id" = t."id"
    `);

    await queryRunner.query(`ALTER TABLE "trigger_run" ADD COLUMN IF NOT EXISTS "run_key" character varying(120)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_trigger_run_key" ON "trigger_run" ("trigger_id", "deal_id", "run_key") WHERE "run_key" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trigger_run_key"`);
    await queryRunner.query(`ALTER TABLE "trigger_run" DROP COLUMN IF EXISTS "run_key"`);
    await queryRunner.query(`ALTER TABLE "trigger" DROP COLUMN IF EXISTS "position"`);
  }
}
