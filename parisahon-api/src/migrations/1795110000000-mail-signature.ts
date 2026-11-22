import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * setting.mail_signature: the company's e-mail signature template (HTML) with {{name}}, {{phone}},
 * {{email}} of the manager. A manager without a signature of their own signs with it.
 */
export class MailSignature1795110000000 implements MigrationInterface {
  name = 'MailSignature1795110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "setting" ADD COLUMN IF NOT EXISTS "mail_signature" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "setting" DROP COLUMN IF EXISTS "mail_signature"`);
  }
}
