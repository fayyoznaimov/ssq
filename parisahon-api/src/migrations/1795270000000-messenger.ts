import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The managers' own Telegram and WhatsApp (src/messenger), two tables without entities (raw SQL,
 * like telegram_remote_file):
 *  - messenger_ignore: «Не клиент» — chats of a manager that never become contacts and deals (family,
 *    friends, suppliers): by Telegram id, WhatsApp chat id or phone (the last 9 digits), for one messenger
 *    or both (channel NULL). Nothing existing is changed: contacts and deals made from such chats before
 *    stay until the manager deletes them.
 *  - messenger_account: per manager and messenger — «только известные контакты» (known_only, NULL = the
 *    server's TELEGRAM_KNOWN_CONTACTS_ONLY), the last session state the API saw and what the manager was
 *    told about it (MessengerHealthService).
 * Both follow the user row: deleted with it (hard deletes of the check sets), so nothing blocks them.
 */
export class Messenger1795270000000 implements MigrationInterface {
  name = 'Messenger1795270000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "messenger_ignore" (
      "id" SERIAL PRIMARY KEY,
      "agent_id" integer NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "channel" varchar(16),
      "tg_id" bigint,
      "wa_id" varchar(64),
      "phone_key" varchar(16),
      "label" varchar(255),
      "contact_id" integer REFERENCES "user"("id") ON DELETE SET NULL,
      "created_by" integer REFERENCES "user"("id") ON DELETE SET NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "CHK_messenger_ignore_channel" CHECK ("channel" IS NULL OR "channel" IN ('telegram', 'whatsapp')),
      CONSTRAINT "CHK_messenger_ignore_something" CHECK ("tg_id" IS NOT NULL OR "wa_id" IS NOT NULL OR "phone_key" IS NOT NULL))`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messenger_ignore_agent" ON "messenger_ignore" ("agent_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "messenger_account" (
      "user_id" integer NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "channel" varchar(16) NOT NULL,
      "known_only" boolean,
      "status" varchar(32),
      "detail" varchar(500),
      "status_at" timestamptz,
      "notified_status" varchar(32),
      "notified_at" timestamptz,
      PRIMARY KEY ("user_id", "channel"),
      CONSTRAINT "CHK_messenger_account_channel" CHECK ("channel" IN ('telegram', 'whatsapp')))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "messenger_account"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "messenger_ignore"`);
  }
}
