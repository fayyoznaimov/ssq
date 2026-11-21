import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1712865715670 implements MigrationInterface {
    name = 'Migrations1712865715670'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deal" ALTER COLUMN "budget" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deal" ALTER COLUMN "budget" SET NOT NULL`);
    }

}
