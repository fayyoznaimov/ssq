import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1715528689342 implements MigrationInterface {
    name = 'Migrations1715528689342'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "recording" ("id" SERIAL NOT NULL, "duration" bigint NOT NULL, "outgoing" boolean NOT NULL DEFAULT true, "path" character varying(255), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "user_id" integer NOT NULL, CONSTRAINT "PK_2f037d57bd6d7f1e4d68d72e6f4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "recording" ADD CONSTRAINT "FK_e94aa361be2e1b97725df1aa46d" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recording" DROP CONSTRAINT "FK_e94aa361be2e1b97725df1aa46d"`);
        await queryRunner.query(`DROP TABLE "recording"`);
    }

}
