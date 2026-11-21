import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1711118987314 implements MigrationInterface {
    name = 'Migrations1711118987314'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "company" ADD "is_old" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "company" DROP COLUMN "is_old"`);
    }

}
