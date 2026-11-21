import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Trash of deals: who moved a deal to the trash (deal.deleted_at already says when).
 * Declared on the entity too (Deal.deleted_by).
 */
export class DealTrash1794970000000 implements MigrationInterface {
  name = 'DealTrash1794970000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deal" ADD "deleted_by" integer`);
    await queryRunner.query(
      `ALTER TABLE "deal" ADD CONSTRAINT "FK_deal_deleted_by" FOREIGN KEY ("deleted_by") REFERENCES "user"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deal" DROP CONSTRAINT "FK_deal_deleted_by"`);
    await queryRunner.query(`ALTER TABLE "deal" DROP COLUMN "deleted_by"`);
  }
}
