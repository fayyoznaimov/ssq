import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1710789194600 implements MigrationInterface {
    name = 'Migrations1710789194600'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user" ADD "tg_api_id" integer`);
        await queryRunner.query(`ALTER TABLE "user" ADD "tg_api_hash" text`);
        await queryRunner.query(`ALTER TABLE "user" ADD "tg_id" bigint`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "tg_id"`);
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "tg_api_hash"`);
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "tg_api_id"`);
    }

}
