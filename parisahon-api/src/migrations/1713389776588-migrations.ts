import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1713389776588 implements MigrationInterface {
    name = 'Migrations1713389776588'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "trigger" ADD "apply_when" character varying(255) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "trigger" ADD "is_delayed" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "trigger" ADD "is_recurring" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "trigger" ADD "deal_filters" jsonb`);
        await queryRunner.query(`ALTER TABLE "trigger" ADD "apply_when_data" jsonb`);
        await queryRunner.query(`ALTER TABLE "trigger" ADD "user_id" integer`);
        await queryRunner.query(`ALTER TABLE "trigger" ADD CONSTRAINT "FK_388a07cef1798781a6e24e894ee" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "trigger" DROP CONSTRAINT "FK_388a07cef1798781a6e24e894ee"`);
        await queryRunner.query(`ALTER TABLE "trigger" DROP COLUMN "user_id"`);
        await queryRunner.query(`ALTER TABLE "trigger" DROP COLUMN "apply_when_data"`);
        await queryRunner.query(`ALTER TABLE "trigger" DROP COLUMN "deal_filters"`);
        await queryRunner.query(`ALTER TABLE "trigger" DROP COLUMN "is_recurring"`);
        await queryRunner.query(`ALTER TABLE "trigger" DROP COLUMN "is_delayed"`);
        await queryRunner.query(`ALTER TABLE "trigger" DROP COLUMN "apply_when"`);
    }

}
