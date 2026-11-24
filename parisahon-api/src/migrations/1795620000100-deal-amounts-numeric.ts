import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fabric is sold by the metre and the kilo, prices can have cents (DB-7): deal_product.quantity and
 * price, deal.budget were bigint, and «12.5» answered 500 (invalid input syntax for type bigint).
 *
 *  - deal_product.quantity numeric(14,3), deal_product.price numeric(18,2), deal.budget numeric(18,2);
 *    every whole value stays the same number;
 *  - negative amounts make no sense (the API refuses them since long): the few test rows that have them
 *    are set to 0, then CHECK constraints keep them out.
 *
 * The API keeps giving these values as text, as it did for bigint, without trailing zeros
 * ("12.5", "16500000"): deal/decimal.ts.
 */
export class DealAmountsNumeric1795620000100 implements MigrationInterface {
  name = 'DealAmountsNumeric1795620000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [, budgets] = await queryRunner.query(`UPDATE "deal" SET "budget" = 0 WHERE "budget" < 0`);
    const [, lines] = await queryRunner.query(
      `UPDATE "deal_product" SET "quantity" = GREATEST("quantity", 0), "price" = GREATEST("price", 0)
        WHERE "quantity" < 0 OR "price" < 0`,
    );
    if (budgets || lines) {
      console.log(`${this.name}: negative amounts set to 0: ${budgets ?? 0} deal budget(s), ${lines ?? 0} product line(s)`);
    }

    await queryRunner.query(`ALTER TABLE "deal" ALTER COLUMN "budget" TYPE numeric(18,2)`);
    await queryRunner.query(
      `ALTER TABLE "deal_product" ALTER COLUMN "quantity" TYPE numeric(14,3), ALTER COLUMN "price" TYPE numeric(18,2)`,
    );

    await queryRunner.query(`ALTER TABLE "deal" DROP CONSTRAINT IF EXISTS "CHK_deal_budget"`);
    await queryRunner.query(`ALTER TABLE "deal" ADD CONSTRAINT "CHK_deal_budget" CHECK ("budget" >= 0)`);
    await queryRunner.query(`ALTER TABLE "deal_product" DROP CONSTRAINT IF EXISTS "CHK_deal_product_amounts"`);
    await queryRunner.query(
      `ALTER TABLE "deal_product" ADD CONSTRAINT "CHK_deal_product_amounts" CHECK ("quantity" >= 0 AND "price" >= 0)`,
    );
  }

  /** Back to whole numbers: fractions are rounded. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deal_product" DROP CONSTRAINT IF EXISTS "CHK_deal_product_amounts"`);
    await queryRunner.query(`ALTER TABLE "deal" DROP CONSTRAINT IF EXISTS "CHK_deal_budget"`);
    await queryRunner.query(
      `ALTER TABLE "deal_product" ALTER COLUMN "quantity" TYPE bigint USING round("quantity"), ALTER COLUMN "price" TYPE bigint USING round("price")`,
    );
    await queryRunner.query(`ALTER TABLE "deal" ALTER COLUMN "budget" TYPE bigint USING round("budget")`);
  }
}
