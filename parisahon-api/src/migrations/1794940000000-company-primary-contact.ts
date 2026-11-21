import { MigrationInterface, QueryRunner } from 'typeorm';

/** The primary contact of a company: its phone and email stand in for the company's when those are empty. */
export class CompanyPrimaryContact1794940000000 implements MigrationInterface {
  name = 'CompanyPrimaryContact1794940000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "company" ADD "primary_contact_id" integer`);
    await queryRunner.query(
      `ALTER TABLE "company" ADD CONSTRAINT "FK_company_primary_contact" FOREIGN KEY ("primary_contact_id") REFERENCES "user"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "company" DROP CONSTRAINT "FK_company_primary_contact"`);
    await queryRunner.query(`ALTER TABLE "company" DROP COLUMN "primary_contact_id"`);
  }
}
