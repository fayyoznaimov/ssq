import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mail: access rights and resynchronisation.
 *  - message_id: the Message-ID header, to find the local copy again after the
 *    mailbox was renumbered (UIDVALIDITY change);
 *  - uidvalidity: UIDVALIDITY of the mailbox the uid (email_id) belongs to;
 *  - sent_by_id: the staff member who sent an outgoing email from the CRM.
 */
export class EmailRightsSync1794910000000 implements MigrationInterface {
  name = 'EmailRightsSync1794910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "email"
        ADD "message_id" character varying(998),
        ADD "uidvalidity" bigint,
        ADD "sent_by_id" integer
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_email_message_id" ON "email" ("message_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "email"
        ADD CONSTRAINT "FK_email_sent_by" FOREIGN KEY ("sent_by_id")
        REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "email" DROP CONSTRAINT "FK_email_sent_by"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_email_message_id"`);
    await queryRunner.query(`
      ALTER TABLE "email"
        DROP COLUMN "sent_by_id",
        DROP COLUMN "uidvalidity",
        DROP COLUMN "message_id"
    `);
  }
}
