import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram bot of the CRM: which chat belongs to which CRM user, one-time
 * link codes from the profile page, and tasks already reminded about.
 */
export class CrmBot1794800000000 implements MigrationInterface {
  name = 'CrmBot1794800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "bot_account" (
        "user_id" integer NOT NULL,
        "chat_id" bigint NOT NULL,
        "tg_username" character varying(255),
        "digest_on" date,
        "linked_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bot_account" PRIMARY KEY ("user_id"),
        CONSTRAINT "FK_bot_account_user" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_bot_account_chat" ON "bot_account" ("chat_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE "bot_link_code" (
        "code_hash" character varying(64) NOT NULL,
        "user_id" integer NOT NULL,
        "expires_at" TIMESTAMP NOT NULL,
        CONSTRAINT "PK_bot_link_code" PRIMARY KEY ("code_hash")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_bot_link_code_user" ON "bot_link_code" ("user_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE "bot_reminder" (
        "task_id" integer NOT NULL,
        "sent_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bot_reminder" PRIMARY KEY ("task_id"),
        CONSTRAINT "FK_bot_reminder_task" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "bot_reminder"`);
    await queryRunner.query(`DROP TABLE "bot_link_code"`);
    await queryRunner.query(`DROP TABLE "bot_account"`);
  }
}
