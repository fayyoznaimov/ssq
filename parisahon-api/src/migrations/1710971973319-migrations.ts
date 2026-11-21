import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1710971973319 implements MigrationInterface {
    name = 'Migrations1710971973319'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "email" ADD "outgoing" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "email" DROP COLUMN "outgoing"`);
    }

}
