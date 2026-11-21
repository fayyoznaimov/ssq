import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1713550002129 implements MigrationInterface {
    name = 'Migrations1713550002129'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "email_to" DROP CONSTRAINT "FK_fef20416e465e9c58a32f4b3ff9"`);
        await queryRunner.query(`ALTER TABLE "email_cc" DROP CONSTRAINT "FK_9b1e2063d126c374b495b8fda19"`);
        await queryRunner.query(`ALTER TABLE "email" ADD "thread_id" character varying(255)`);
        await queryRunner.query(`ALTER TABLE "file" DROP COLUMN "extension"`);
        await queryRunner.query(`ALTER TABLE "file" ADD "extension" character varying(255)`);
        await queryRunner.query(`ALTER TABLE "email_to" ADD CONSTRAINT "FK_fef20416e465e9c58a32f4b3ff9" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "email_cc" ADD CONSTRAINT "FK_9b1e2063d126c374b495b8fda19" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "email_cc" DROP CONSTRAINT "FK_9b1e2063d126c374b495b8fda19"`);
        await queryRunner.query(`ALTER TABLE "email_to" DROP CONSTRAINT "FK_fef20416e465e9c58a32f4b3ff9"`);
        await queryRunner.query(`ALTER TABLE "file" DROP COLUMN "extension"`);
        await queryRunner.query(`ALTER TABLE "file" ADD "extension" character varying(10)`);
        await queryRunner.query(`ALTER TABLE "email" DROP COLUMN "thread_id"`);
        await queryRunner.query(`ALTER TABLE "email_cc" ADD CONSTRAINT "FK_9b1e2063d126c374b495b8fda19" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "email_to" ADD CONSTRAINT "FK_fef20416e465e9c58a32f4b3ff9" FOREIGN KEY ("email_id") REFERENCES "email"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

}
