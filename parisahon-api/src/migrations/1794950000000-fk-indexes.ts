import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes on the foreign keys the CRM filters and joins by (the history of a deal,
 * the deals of a stage / manager / company, the tasks of a deal, the contacts of a
 * company, custom field values, ...): Postgres does not index foreign keys by itself.
 * Declared on the entities too (@Index), so the schema and the code stay the same.
 */
export class ForeignKeyIndexes1794950000000 implements MigrationInterface {
  name = 'ForeignKeyIndexes1794950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_event_deal_created" ON "event" ("deal_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_event_user" ON "event" ("user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_event_target_user" ON "event" ("target_user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_event_task" ON "event" ("task_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deal_stage" ON "deal" ("stage_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deal_agent" ON "deal" ("agent_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deal_company" ON "deal" ("company_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deal_filler_deal" ON "deal_filler" ("deal_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deal_product_deal" ON "deal_product" ("deal_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deal_stage_record_deal" ON "deal_stage_record" ("deal_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deal_stage_collection" ON "deal_stage" ("collection_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_task_deal" ON "task" ("deal_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_task_agent" ON "task" ("agent_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_task_company" ON "task" ("company_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_company" ON "user" ("company_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_tg_id" ON "user" ("tg_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_company_filler_company" ON "company_filler" ("company_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_filler_user" ON "user_filler" ("user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_product_filler_product" ON "product_filler" ("product_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_file_email" ON "file" ("email_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_email_to_email" ON "email_to" ("email_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_email_cc_email" ON "email_cc" ("email_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recording_user" ON "recording" ("user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trigger_deal_stage" ON "trigger" ("deal_stage_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trigger_run_deal" ON "trigger_run" ("deal_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_call_upload_user" ON "call_upload" ("user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_phone_digits" ON "user" (regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g')) WHERE "role" = 'ctr_agent'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_phone_digits"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_call_upload_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trigger_run_deal"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trigger_deal_stage"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recording_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_email_cc_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_email_to_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_file_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_product_filler_product"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_filler_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_company_filler_company"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_tg_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_company"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_task_company"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_task_agent"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_task_deal"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deal_stage_collection"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deal_stage_record_deal"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deal_product_deal"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deal_filler_deal"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deal_company"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deal_agent"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deal_stage"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_task"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_target_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_deal_created"`);
  }
}
