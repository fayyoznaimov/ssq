import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deal numbers (deal.display_id) become sequential: 1, 2, 3 ... in the order the deals
 * were created (created_at, then id), deals in the trash included. New deals continue
 * with max + 1 (HelperService.saveNewDeal).
 *
 * A deal named after its old number ("#48912534", the name a deal gets when it is created
 * without one) is renamed after the new number. Everything else is left as it was: the
 * history keeps the old number where it stored a copy of the deal (after_state of the
 * "deal created" event), nothing shows it.
 *
 * The old numbers and names stay in deal_number_backup (deal_id, display_id, label), which
 * `down` uses to put them back.
 */
export class DealNumbers1794970000001 implements MigrationInterface {
  name = 'DealNumbers1794970000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "deal_number_backup" ("deal_id" integer PRIMARY KEY, "display_id" integer NOT NULL, "label" character varying(255))`,
    );
    await queryRunner.query(
      `INSERT INTO "deal_number_backup" ("deal_id", "display_id", "label")
       SELECT "id", "display_id", "label" FROM "deal" ON CONFLICT ("deal_id") DO NOTHING`,
    );
    // The unique index is checked row by row: free every number first (-id is unique)
    await queryRunner.query(`UPDATE "deal" SET "display_id" = -"id"`);
    await queryRunner.query(
      `WITH numbered AS (
         SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at", "id") AS "number" FROM "deal"
       )
       UPDATE "deal" d
          SET "display_id" = n."number",
              "label" = CASE WHEN d."label" = '#' || b."display_id" THEN '#' || n."number" ELSE d."label" END
         FROM numbered n
         LEFT JOIN "deal_number_backup" b ON b."deal_id" = n."id"
        WHERE d."id" = n."id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Old names come back only where `up` renamed the deal; numbers are freed first (unique index)
    await queryRunner.query(
      `UPDATE "deal" d
          SET "label" = CASE WHEN d."label" = '#' || d."display_id" AND b."label" = '#' || b."display_id" THEN b."label" ELSE d."label" END,
              "display_id" = -d."id"
         FROM "deal_number_backup" b
        WHERE b."deal_id" = d."id"`,
    );
    await queryRunner.query(
      `UPDATE "deal" d SET "display_id" = b."display_id" FROM "deal_number_backup" b WHERE b."deal_id" = d."id"`,
    );
    await queryRunner.query(`DROP TABLE "deal_number_backup"`);
  }
}
