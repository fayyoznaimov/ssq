import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1711152796699 implements MigrationInterface {
    name = 'Migrations1711152796699'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deal" DROP CONSTRAINT "FK_3e4a58fefdb8545f134d763ea7e"`);
        await queryRunner.query(`ALTER TABLE "deal" RENAME COLUMN "createdById" TO "created_by"`);
        await queryRunner.query(`ALTER TABLE "event" ADD "outgoing" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "event" ADD "tg_message_id" bigint`);
        await queryRunner.query(`ALTER TABLE "event" ADD "duration" bigint`);
        await queryRunner.query(`ALTER TABLE "event" ADD "replied_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "deal" ADD CONSTRAINT "FK_a026369d6a9d62e630180a01fd2" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deal" DROP CONSTRAINT "FK_a026369d6a9d62e630180a01fd2"`);
        await queryRunner.query(`ALTER TABLE "event" DROP COLUMN "replied_at"`);
        await queryRunner.query(`ALTER TABLE "event" DROP COLUMN "duration"`);
        await queryRunner.query(`ALTER TABLE "event" DROP COLUMN "tg_message_id"`);
        await queryRunner.query(`ALTER TABLE "event" DROP COLUMN "outgoing"`);
        await queryRunner.query(`ALTER TABLE "deal" RENAME COLUMN "created_by" TO "createdById"`);
        await queryRunner.query(`ALTER TABLE "deal" ADD CONSTRAINT "FK_3e4a58fefdb8545f134d763ea7e" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

}
