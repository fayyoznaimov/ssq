import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1716146674443 implements MigrationInterface {
    name = 'Migrations1716146674443'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "trigger" DROP CONSTRAINT "FK_b832c92d53460b31f733fb01724"`);
        await queryRunner.query(`ALTER TABLE "trigger" ADD CONSTRAINT "FK_b832c92d53460b31f733fb01724" FOREIGN KEY ("deal_stage_id") REFERENCES "deal_stage"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "trigger" DROP CONSTRAINT "FK_b832c92d53460b31f733fb01724"`);
        await queryRunner.query(`ALTER TABLE "trigger" ADD CONSTRAINT "FK_b832c92d53460b31f733fb01724" FOREIGN KEY ("deal_stage_id") REFERENCES "deal_stage"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

}
