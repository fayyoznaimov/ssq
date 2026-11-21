import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1744998645055 implements MigrationInterface {
    name = 'Migrations1744998645055'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recording" ADD "from_number" character varying(255)`);
        await queryRunner.query(`ALTER TABLE "notification" DROP CONSTRAINT "FK_519997b6af92b3a98a52d03d3d6"`);
        await queryRunner.query(`ALTER TABLE "notification" ALTER COLUMN "company_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "email" ALTER COLUMN "sent_at" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "notification" ADD CONSTRAINT "FK_519997b6af92b3a98a52d03d3d6" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification" DROP CONSTRAINT "FK_519997b6af92b3a98a52d03d3d6"`);
        await queryRunner.query(`ALTER TABLE "email" ALTER COLUMN "sent_at" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "notification" ALTER COLUMN "company_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "notification" ADD CONSTRAINT "FK_519997b6af92b3a98a52d03d3d6" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "recording" DROP COLUMN "from_number"`);
    }

}
