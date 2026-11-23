import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Products get the catalogue fields the deal needs: the article (артикул), the unit (м, кг, шт …) and the
 * base price of one unit (numeric: 12.50 is a price; the deal suggests it instead of asking every time).
 * All optional: existing products keep working without them.
 */
export class ProductCatalogue1795230000001 implements MigrationInterface {
  name = 'ProductCatalogue1795230000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "sku" character varying(64)`);
    await queryRunner.query(`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "unit" character varying(32)`);
    await queryRunner.query(`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "price" numeric(14,2)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "product" DROP COLUMN IF EXISTS "price"`);
    await queryRunner.query(`ALTER TABLE "product" DROP COLUMN IF EXISTS "unit"`);
    await queryRunner.query(`ALTER TABLE "product" DROP COLUMN IF EXISTS "sku"`);
  }
}
