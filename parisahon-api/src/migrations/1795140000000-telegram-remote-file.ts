import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * telegram_remote_file: a file of a Telegram message that was too big to save in the CRM. It stays in
 * Telegram; the row says where (whose account, which chat and message), and the unguessable token is
 * the download link GET /telegram/remote-file/:token.
 */
export class TelegramRemoteFile1795140000000 implements MigrationInterface {
  name = 'TelegramRemoteFile1795140000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "telegram_remote_file" (
      "token" varchar(64) PRIMARY KEY,
      "agent_id" integer NOT NULL,
      "chat_tg_id" bigint NOT NULL,
      "tg_message_id" integer NOT NULL,
      "name" varchar(255) NOT NULL,
      "kind" varchar(32),
      "size" bigint,
      "mime" varchar(128),
      "created_at" timestamptz NOT NULL DEFAULT now())`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_telegram_remote_file_message" ON "telegram_remote_file" ("agent_id", "chat_tg_id", "tg_message_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_remote_file"`);
  }
}
