import { MigrationInterface, QueryRunner } from 'typeorm';

/** The client's profile photo from Telegram / WhatsApp (a file name in public/uploads). */
export class ContactAvatar1794990000000 implements MigrationInterface {
  name = 'ContactAvatar1794990000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ADD "avatar" character varying(255)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "avatar"`);
  }
}
