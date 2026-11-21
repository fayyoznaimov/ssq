import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1713499198556 implements MigrationInterface {
    name = 'Migrations1713499198556'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "filler" ADD "is_required" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "filler" DROP COLUMN "is_required"`);
    }

}
