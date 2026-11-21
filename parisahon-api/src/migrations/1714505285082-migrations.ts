import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1714505285082 implements MigrationInterface {
    name = 'Migrations1714505285082'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "file" ADD "created_at" TIMESTAMP NOT NULL DEFAULT now()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "file" DROP COLUMN "created_at"`);
    }

}
