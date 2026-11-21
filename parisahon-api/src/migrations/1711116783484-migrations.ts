import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1711116783484 implements MigrationInterface {
    name = 'Migrations1711116783484'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deal" ADD "closed_at" TIMESTAMP`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deal" DROP COLUMN "closed_at"`);
    }

}
