import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1710948082660 implements MigrationInterface {
    name = 'Migrations1710948082660'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "setting" ("id" SERIAL NOT NULL, "default_stage_id" integer, "defaultAgentId" integer, CONSTRAINT "PK_fcb21187dc6094e24a48f677bed" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "setting" ADD CONSTRAINT "FK_04b9fc5e6e256d2bec3c697950e" FOREIGN KEY ("default_stage_id") REFERENCES "deal_stage"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "setting" ADD CONSTRAINT "FK_e9a1086f24e8261cbfbf96414d7" FOREIGN KEY ("defaultAgentId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "setting" DROP CONSTRAINT "FK_e9a1086f24e8261cbfbf96414d7"`);
        await queryRunner.query(`ALTER TABLE "setting" DROP CONSTRAINT "FK_04b9fc5e6e256d2bec3c697950e"`);
        await queryRunner.query(`DROP TABLE "setting"`);
    }

}
