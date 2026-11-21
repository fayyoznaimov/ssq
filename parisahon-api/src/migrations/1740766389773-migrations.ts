import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1740766389773 implements MigrationInterface {
    name = 'Migrations1740766389773'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "notification" ("id" SERIAL NOT NULL, "message" character varying(255) NOT NULL, "company_id" integer, CONSTRAINT "PK_705b6c7cdf9b2c2ff7ac7872cb7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "notification" ADD CONSTRAINT "FK_519997b6af92b3a98a52d03d3d6" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification" DROP CONSTRAINT "FK_519997b6af92b3a98a52d03d3d6"`);
        await queryRunner.query(`DROP TABLE "notification"`);
    }

}
