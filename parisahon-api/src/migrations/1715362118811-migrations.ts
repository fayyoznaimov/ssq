import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1715362118811 implements MigrationInterface {
    name = 'Migrations1715362118811'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "deal_stage_record" ("id" SERIAL NOT NULL, "moved_after_minutes" bigint, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "deal_id" integer, "stage_id" integer, CONSTRAINT "PK_8851f54788485c688569e66f99f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "deal_stage_record" ADD CONSTRAINT "FK_8f893f0057df353a5cc1ce6df78" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "deal_stage_record" ADD CONSTRAINT "FK_c912e867700cf600e0911eaa7b4" FOREIGN KEY ("stage_id") REFERENCES "deal_stage"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deal_stage_record" DROP CONSTRAINT "FK_c912e867700cf600e0911eaa7b4"`);
        await queryRunner.query(`ALTER TABLE "deal_stage_record" DROP CONSTRAINT "FK_8f893f0057df353a5cc1ce6df78"`);
        await queryRunner.query(`DROP TABLE "deal_stage_record"`);
    }

}
