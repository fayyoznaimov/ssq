import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WhatsApp chats of the managers (parisahon-whatsapp-service, src/whatsapp):
 *  - user.wa_id: the WhatsApp chat id (JID) of a client contact, for chats where
 *    WhatsApp does not give the phone number (LID addressing);
 *  - event.external_id: the WhatsApp message id (a string, unlike tg_message_id),
 *    so a message retried by the service is not saved twice.
 */
export class Whatsapp1794980000000 implements MigrationInterface {
  name = 'Whatsapp1794980000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ADD "wa_id" character varying(64)`);
    await queryRunner.query(`CREATE INDEX "IDX_user_wa_id" ON "user" ("wa_id")`);
    await queryRunner.query(`ALTER TABLE "event" ADD "external_id" character varying(128)`);
    await queryRunner.query(`CREATE INDEX "IDX_event_external_id" ON "event" ("external_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_event_external_id"`);
    await queryRunner.query(`ALTER TABLE "event" DROP COLUMN "external_id"`);
    await queryRunner.query(`DROP INDEX "IDX_user_wa_id"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "wa_id"`);
  }
}
