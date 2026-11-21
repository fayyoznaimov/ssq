import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deals: soft delete + unique display_id.
 *
 * 1. deal.deleted_at — a deal is no longer removed physically (its tasks, events,
 *    files and stage history reference it), it is only marked as deleted.
 * 2. deal.display_id becomes unique. Rows that already share a display_id
 *    (the number used to be random without any check) keep the oldest one,
 *    the newer duplicates get a fresh random number.
 */
export class Migrations1794671493802 implements MigrationInterface {
  name = 'Migrations1794671493802';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deal" ADD "deleted_at" TIMESTAMP`);

    await queryRunner.query(`
      DO $$
      DECLARE
        r RECORD;
        candidate integer;
      BEGIN
        FOR r IN
          SELECT x.id, x.display_id
          FROM (
            SELECT id, display_id,
                   row_number() OVER (PARTITION BY display_id ORDER BY id) AS rn
            FROM "deal"
          ) x
          WHERE x.rn > 1
        LOOP
          LOOP
            candidate := floor(random() * 90000000 + 10000000)::int;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM "deal" WHERE display_id = candidate);
          END LOOP;

          UPDATE "deal"
          SET display_id = candidate,
              label = CASE
                WHEN label = '#' || r.display_id THEN '#' || candidate
                ELSE label
              END
          WHERE id = r.id;
        END LOOP;
      END $$;
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_deal_display_id" ON "deal" ("display_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_deal_display_id"`);
    await queryRunner.query(`ALTER TABLE "deal" DROP COLUMN "deleted_at"`);
  }
}
