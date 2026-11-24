import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-15: the invariants the code relies on are kept by the database too.
 *
 * NOT NULL on the parent of a child row: a custom field value without its company / deal / contact /
 * product or without its field, a product line without its deal or product, a recipient of no letter,
 * a stage history row without its deal or stage, a trigger without its stage, a deal without a stage.
 * (TypeORM used to set the parent to NULL when a row fell out of its parent's list: such rows were lost
 * from sight, not deleted.) Rows that break it are repaired first:
 *  - a value, product line, recipient or history row without its parent belongs to nothing: deleted;
 *  - a trigger without a stage never runs: deleted (with its runs);
 *  - a deal without a stage is put into the stage for new deals (the settings, else the «new» stage of
 *    the active pipeline), so it shows on the board again; without such a stage the column stays nullable.
 * On the production copy (QA, 2026-11-24) nothing breaks any of them.
 *
 * CHECK: a role and the target of a custom field are one of the known ones, the status of a call upload
 * and of a trigger run is one of its enum (calls/call-upload.entity.ts, trigger/trigger-run.entity.ts), a
 * task does not end before it starts. Added NOT VALID, then validated (no long lock); a row that breaks
 * one stops the migration with its name, nothing is changed silently. event.type has no CHECK: the list of
 * event types grows with the features and a forgotten CHECK would make the next new type fail.
 * Running it again changes nothing.
 */
const NOT_NULL: { table: string; column: string; repair: string }[] = [
  { table: 'company_filler', column: 'company_id', repair: `DELETE FROM "company_filler" WHERE "company_id" IS NULL` },
  { table: 'company_filler', column: 'filler_id', repair: `DELETE FROM "company_filler" WHERE "filler_id" IS NULL` },
  { table: 'deal_filler', column: 'deal_id', repair: `DELETE FROM "deal_filler" WHERE "deal_id" IS NULL` },
  { table: 'deal_filler', column: 'filler_id', repair: `DELETE FROM "deal_filler" WHERE "filler_id" IS NULL` },
  { table: 'user_filler', column: 'user_id', repair: `DELETE FROM "user_filler" WHERE "user_id" IS NULL` },
  { table: 'user_filler', column: 'filler_id', repair: `DELETE FROM "user_filler" WHERE "filler_id" IS NULL` },
  { table: 'deal_product', column: 'deal_id', repair: `DELETE FROM "deal_product" WHERE "deal_id" IS NULL` },
  { table: 'deal_product', column: 'product_id', repair: `DELETE FROM "deal_product" WHERE "product_id" IS NULL` },
  { table: 'email_to', column: 'email_id', repair: `DELETE FROM "email_to" WHERE "email_id" IS NULL` },
  { table: 'email_cc', column: 'email_id', repair: `DELETE FROM "email_cc" WHERE "email_id" IS NULL` },
  { table: 'deal_stage_record', column: 'deal_id', repair: `DELETE FROM "deal_stage_record" WHERE "deal_id" IS NULL` },
  { table: 'deal_stage_record', column: 'stage_id', repair: `DELETE FROM "deal_stage_record" WHERE "stage_id" IS NULL` },
  { table: 'trigger', column: 'deal_stage_id', repair: `DELETE FROM "trigger" WHERE "deal_stage_id" IS NULL` },
  {
    table: 'deal',
    column: 'stage_id',
    repair: `UPDATE "deal" SET "stage_id" = COALESCE(
               (SELECT st."default_stage_id" FROM "setting" st JOIN "deal_stage" s ON s.id = st."default_stage_id"
                 WHERE st."default_stage_id" IS NOT NULL ORDER BY st.id LIMIT 1),
               (SELECT s.id FROM "deal_stage" s JOIN "collection" c ON c.id = s."collection_id"
                 WHERE c."is_active" AND s."kind" = 'new' ORDER BY s.id LIMIT 1))
             WHERE "stage_id" IS NULL`,
  },
];

const CHECKS: { table: string; name: string; expression: string }[] = [
  { table: 'user', name: 'CHK_user_role', expression: `"role" IN ('admin', 'manager', 'agent', 'ctr_agent')` },
  { table: 'filler', name: 'CHK_filler_target', expression: `"target" IN ('company', 'deal', 'user', 'product')` },
  {
    table: 'call_upload',
    name: 'CHK_call_upload_status',
    expression: `"status" IN ('pending', 'done', 'failed', 'discarded', 'duplicate')`,
  },
  {
    table: 'trigger_run',
    name: 'CHK_trigger_run_status',
    expression: `"status" IN ('pending', 'running', 'done', 'failed', 'skipped')`,
  },
  { table: 'task', name: 'CHK_task_times', expression: `"end_time" >= "start_time"` },
];

export class ChildKeysChecks1795722000000 implements MigrationInterface {
  name = 'ChildKeysChecks1795722000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const n of NOT_NULL) {
      await queryRunner.query(n.repair);
      const [{ missing }] = await queryRunner.query(
        `SELECT count(*)::int AS missing FROM "${n.table}" WHERE "${n.column}" IS NULL`,
      );
      if (missing > 0) {
        // only a deal without a stage when there is no stage to put it in: the column stays nullable
        console.warn(`${n.table}.${n.column}: ${missing} rows without a value, NOT NULL is not set`);
        continue;
      }
      await queryRunner.query(`ALTER TABLE "${n.table}" ALTER COLUMN "${n.column}" SET NOT NULL`);
    }
    for (const c of CHECKS) {
      const [exists] = await queryRunner.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = format('%I', $2::text)::regclass`,
        [c.name, c.table],
      );
      if (!exists) {
        await queryRunner.query(`ALTER TABLE "${c.table}" ADD CONSTRAINT "${c.name}" CHECK (${c.expression}) NOT VALID`);
      }
      await queryRunner.query(`ALTER TABLE "${c.table}" VALIDATE CONSTRAINT "${c.name}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const c of CHECKS) {
      await queryRunner.query(`ALTER TABLE "${c.table}" DROP CONSTRAINT IF EXISTS "${c.name}"`);
    }
    for (const n of NOT_NULL) {
      await queryRunner.query(`ALTER TABLE "${n.table}" ALTER COLUMN "${n.column}" DROP NOT NULL`);
    }
  }
}
