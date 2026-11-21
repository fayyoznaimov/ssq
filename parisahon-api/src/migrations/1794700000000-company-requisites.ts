import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Company requisites as real columns instead of free-form custom fields:
 * they are filled from a photo of the company card and will later be used to
 * match the company with 1C (by ИНН). All of them are optional.
 */
export class CompanyRequisites1794700000000 implements MigrationInterface {
  name = 'CompanyRequisites1794700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "company"
        ADD "inn" character varying(20),
        ADD "legal_address" text,
        ADD "bank_account" character varying(34),
        ADD "bank_name" character varying(255),
        ADD "mfo" character varying(20),
        ADD "oked" character varying(20),
        ADD "director" character varying(255)
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_company_inn" ON "company" ("inn")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_company_inn"`);
    await queryRunner.query(`
      ALTER TABLE "company"
        DROP COLUMN "director",
        DROP COLUMN "oked",
        DROP COLUMN "mfo",
        DROP COLUMN "bank_name",
        DROP COLUMN "bank_account",
        DROP COLUMN "legal_address",
        DROP COLUMN "inn"
    `);
  }
}
