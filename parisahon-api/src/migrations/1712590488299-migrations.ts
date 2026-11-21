import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1712590488299 implements MigrationInterface {
    name = 'Migrations1712590488299'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "email_template" ("id" SERIAL NOT NULL, "template_body" text NOT NULL, "name" character varying(255), "subject" character varying(255), "created_by" integer, CONSTRAINT "PK_c90815fd4ca9119f19462207710" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "trigger" ("id" SERIAL NOT NULL, "type" smallint NOT NULL, "data" jsonb, "deal_stage_id" integer, CONSTRAINT "PK_fc6b3cbbe199d89c002831e03e8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "email" ADD "is_spam" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "email" ADD "deleted_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "email_template" ADD CONSTRAINT "FK_b6ee8e5ebd8cc8e306a2fdcdd23" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "trigger" ADD CONSTRAINT "FK_b832c92d53460b31f733fb01724" FOREIGN KEY ("deal_stage_id") REFERENCES "deal_stage"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "trigger" DROP CONSTRAINT "FK_b832c92d53460b31f733fb01724"`);
        await queryRunner.query(`ALTER TABLE "email_template" DROP CONSTRAINT "FK_b6ee8e5ebd8cc8e306a2fdcdd23"`);
        await queryRunner.query(`ALTER TABLE "email" DROP COLUMN "deleted_at"`);
        await queryRunner.query(`ALTER TABLE "email" DROP COLUMN "is_spam"`);
        await queryRunner.query(`DROP TABLE "trigger"`);
        await queryRunner.query(`DROP TABLE "email_template"`);
    }

}
