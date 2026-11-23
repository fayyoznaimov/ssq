import { MigrationInterface, QueryRunner } from 'typeorm';
import { normalizePhone } from '../helper/phone';

/**
 * Companies, contacts and staff:
 *  1. Phones are stored in one format (helper/phone.ts): "+998 (90) 123-45-67", "998901234567" and the
 *     local "90 123 45 67" become "+998901234567", so Telegram, WhatsApp, calls and the duplicate check
 *     find the same client. Only numbers that turn into a clean "+digits" are changed; text that is not
 *     one clear number (letters, two numbers, "8 90 …") stays as typed. The note: every changed phone is
 *     kept as typed in phone_original (table, row, before, after); `down` puts them back.
 *  2. The name of a company is unique among the companies that are not deleted: the unique index
 *     covered deleted ones, so the name of a deleted company could not be used again.
 *  3. Expression indexes on the last 9 digits of the phone (phoneKeySql) for the lookups by phone.
 */
export class PeoplePhones1795230000000 implements MigrationInterface {
  name = 'PeoplePhones1795230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------------------------------------ 1. phones
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "phone_original" (
      "id" SERIAL PRIMARY KEY,
      "entity" varchar(16) NOT NULL,
      "row_id" integer NOT NULL,
      "phone" varchar(255) NOT NULL,
      "normalized" varchar(255) NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now())`);

    for (const table of ['user', 'company']) {
      const rows: { id: number; phone: string }[] = await queryRunner.query(
        `SELECT id, phone FROM "${table}" WHERE phone IS NOT NULL AND btrim(phone) <> '' ORDER BY id`,
      );
      for (const row of rows) {
        const normalized = normalizePhone(row.phone);
        if (!normalized || normalized === row.phone || !/^\+\d{7,15}$/.test(normalized)) continue;
        await queryRunner.query(
          `INSERT INTO "phone_original" ("entity", "row_id", "phone", "normalized") VALUES ($1, $2, $3, $4)`,
          [table, row.id, row.phone, normalized],
        );
        // a plain UPDATE: updated_at keeps the time of the last real change
        await queryRunner.query(`UPDATE "${table}" SET "phone" = $1 WHERE "id" = $2`, [normalized, row.id]);
      }
    }

    // ------------------------------------------------------------ 2. company names
    // created while the old index still holds, so it cannot fail on existing data
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_company_name_live" ON "company" ("name") WHERE "deleted_at" IS NULL`,
    );
    // the full unique index on company(name) (migration 1710016292238), found by its definition
    await queryRunner.query(`
      DO $$
      DECLARE idx record;
      BEGIN
        FOR idx IN
          SELECT i.relname AS name
          FROM pg_index x
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_class t ON t.oid = x.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
          WHERE n.nspname = current_schema() AND t.relname = 'company' AND x.indisunique AND NOT x.indisprimary
            AND x.indnatts = 1 AND x.indpred IS NULL AND x.indexprs IS NULL AND a.attname = 'name'
            AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
        LOOP
          EXECUTE format('DROP INDEX %I.%I', current_schema(), idx.name);
        END LOOP;
      END $$;
    `);

    // ------------------------------------------------------------ 3. lookups by phone
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_phone_key" ON "user" (right(regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g'), 9)) WHERE "role" = 'ctr_agent'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_company_phone_key" ON "company" (right(regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g'), 9)) WHERE "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_company_phone_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_phone_key"`);
    // fails if a deleted company's name has been given to a new company meanwhile
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_a76c5cd486f7779bd9c319afd2" ON "company" ("name")`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_company_name_live"`);
    // the phones as they were typed (unless they were changed again since)
    for (const table of ['user', 'company']) {
      await queryRunner.query(
        `UPDATE "${table}" t SET "phone" = p."phone"
           FROM "phone_original" p
          WHERE p."entity" = $1 AND p."row_id" = t."id" AND t."phone" = p."normalized"`,
        [table],
      );
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "phone_original"`);
  }
}
