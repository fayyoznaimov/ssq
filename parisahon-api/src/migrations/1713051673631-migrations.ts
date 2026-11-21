import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1713051673631 implements MigrationInterface {
    name = 'Migrations1713051673631'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "file" ADD "size" bigint NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "file" ADD "from" character varying(255) NOT NULL DEFAULT 'from_emails'`);
        await queryRunner.query(`ALTER TABLE "file" ADD "extension" character varying(10)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "file" DROP COLUMN "extension"`);
        await queryRunner.query(`ALTER TABLE "file" DROP COLUMN "from"`);
        await queryRunner.query(`ALTER TABLE "file" DROP COLUMN "size"`);
    }

}
