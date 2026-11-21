import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One time zone for every timestamp. The API writes its own times (deadlines, stage changes,
 * closing, e-mail dates) in its zone (TZ, Asia/Karachi), while everything the database filled
 * itself (created_at / updated_at defaults, soft deletes, now()) was UTC — 5 hours apart, so a
 * new deal showed up created 5 hours earlier than it was, and comparisons between the two kinds
 * were wrong. From now on the database works in the API's zone (ALTER DATABASE, and the
 * connection sets it too, see datasource.ts), and the values it filled before are moved from
 * UTC into that zone. Columns written by the API are not touched.
 * Not shifted on purpose: user.deleted_at and email.deleted_at (written by the API as well as by
 * soft deletes), trigger_run.executed_at (mostly written by the API).
 */
export class TimeZone1794960000000 implements MigrationInterface {
  name = 'TimeZone1794960000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tz = process.env.TZ || 'Asia/Karachi';
    await queryRunner.query(
      `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), '${tz}'); END $$`,
    );
    for (const sql of [
      `UPDATE "bot_account" SET "linked_at" = ("linked_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "linked_at" IS NOT NULL`,
      `UPDATE "bot_reminder" SET "sent_at" = ("sent_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "sent_at" IS NOT NULL`,
      `UPDATE "call_upload" SET "received_at" = ("received_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "received_at" IS NOT NULL`,
      `UPDATE "collection" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "company" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "company" SET "updated_at" = ("updated_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "updated_at" IS NOT NULL`,
      `UPDATE "company" SET "deleted_at" = ("deleted_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "deleted_at" IS NOT NULL`,
      `UPDATE "company_filler" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "deal" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "deal" SET "deleted_at" = ("deleted_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "deleted_at" IS NOT NULL`,
      `UPDATE "deal_filler" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "deal_stage" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "deal_stage_record" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "email_transporter" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "event" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL AND type <> 9`,
      `UPDATE "event" SET "replied_at" = ("replied_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "replied_at" IS NOT NULL`,
      `UPDATE "file" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "filler" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "group" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "product" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "product" SET "deleted_at" = ("deleted_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "deleted_at" IS NOT NULL`,
      `UPDATE "product_filler" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "recorder_token" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "recording" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "task" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "trigger" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "trigger_run" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "user" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
      `UPDATE "user" SET "updated_at" = ("updated_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "updated_at" IS NOT NULL`,
      `UPDATE "user_filler" SET "created_at" = ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE '${tz}' WHERE "created_at" IS NOT NULL`,
    ]) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tz = process.env.TZ || 'Asia/Karachi';
    for (const sql of [
      `UPDATE "bot_account" SET "linked_at" = ("linked_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "linked_at" IS NOT NULL`,
      `UPDATE "bot_reminder" SET "sent_at" = ("sent_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "sent_at" IS NOT NULL`,
      `UPDATE "call_upload" SET "received_at" = ("received_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "received_at" IS NOT NULL`,
      `UPDATE "collection" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "company" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "company" SET "updated_at" = ("updated_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "updated_at" IS NOT NULL`,
      `UPDATE "company" SET "deleted_at" = ("deleted_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "deleted_at" IS NOT NULL`,
      `UPDATE "company_filler" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "deal" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "deal" SET "deleted_at" = ("deleted_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "deleted_at" IS NOT NULL`,
      `UPDATE "deal_filler" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "deal_stage" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "deal_stage_record" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "email_transporter" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "event" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL AND type <> 9`,
      `UPDATE "event" SET "replied_at" = ("replied_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "replied_at" IS NOT NULL`,
      `UPDATE "file" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "filler" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "group" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "product" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "product" SET "deleted_at" = ("deleted_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "deleted_at" IS NOT NULL`,
      `UPDATE "product_filler" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "recorder_token" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "recording" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "task" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "trigger" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "trigger_run" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "user" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
      `UPDATE "user" SET "updated_at" = ("updated_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "updated_at" IS NOT NULL`,
      `UPDATE "user_filler" SET "created_at" = ("created_at" AT TIME ZONE '${tz}') AT TIME ZONE 'UTC' WHERE "created_at" IS NOT NULL`,
    ]) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(
      `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I RESET timezone', current_database()); END $$`,
    );
  }
}
