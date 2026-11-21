import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1712594309079 implements MigrationInterface {
    name = 'Migrations1712594309079'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user" ADD "sign" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "sign"`);
    }

}
