import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Why a deal was lost (DEAL-11): closing a deal in the stage of kind `lost` («Закрыто и не
 * реализовано») asks for the reason — one of a short list (src/history/lost-reasons.ts) — and a
 * comment (PATCH /deals/:id/lost). Both are kept on the deal for the reports and written to its
 * history. Old closed deals have none (NULL): nothing to fill in.
 */
export class DealLostReason1795850000000 implements MigrationInterface {
  name = 'DealLostReason1795850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "lost_reason" character varying(120)`);
    await queryRunner.query(`ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "lost_comment" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deal" DROP COLUMN IF EXISTS "lost_comment"`);
    await queryRunner.query(`ALTER TABLE "deal" DROP COLUMN IF EXISTS "lost_reason"`);
  }
}
