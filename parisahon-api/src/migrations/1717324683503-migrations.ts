import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migrations1717324683503 implements MigrationInterface {
  name = 'Migrations1717324683503';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "group" ADD "objectives" jsonb NOT NULL DEFAULT '{"monthly":0,"quarterly":0,"yearly":0}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "objectives" jsonb NOT NULL DEFAULT '{"monthly":0,"quarterly":0,"yearly":0}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "objectives"`);
    await queryRunner.query(`ALTER TABLE "group" DROP COLUMN "objectives"`);
  }
}
