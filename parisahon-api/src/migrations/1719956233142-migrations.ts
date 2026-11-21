import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1719956233142 implements MigrationInterface {
    name = 'Migrations1719956233142'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user" ADD "deleted_by" integer`);
        await queryRunner.query(`ALTER TABLE "user" ADD CONSTRAINT "FK_7dda804b73a73af1c4fcab9a5bc" FOREIGN KEY ("deleted_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user" DROP CONSTRAINT "FK_7dda804b73a73af1c4fcab9a5bc"`);
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "deleted_by"`);
    }

}
