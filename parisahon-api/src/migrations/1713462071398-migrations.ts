import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1713462071398 implements MigrationInterface {
    name = 'Migrations1713462071398'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deal" ADD "last_stage_change" TIMESTAMP`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deal" DROP COLUMN "last_stage_change"`);
    }

}
