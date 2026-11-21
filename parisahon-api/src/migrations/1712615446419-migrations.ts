import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1712615446419 implements MigrationInterface {
    name = 'Migrations1712615446419'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "email" ADD "from_mailbox" character varying(255) NOT NULL DEFAULT 'INBOX'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "email" DROP COLUMN "from_mailbox"`);
    }

}
