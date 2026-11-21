import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1710165131242 implements MigrationInterface {
    name = 'Migrations1710165131242'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "email" ALTER COLUMN "email_id" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "email" ALTER COLUMN "email_id" SET NOT NULL`);
    }

}
