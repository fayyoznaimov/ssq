import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One client — one record, checked by the database too (the API checks first; two requests at once
 * passed the checks and the second one got a 500 or a duplicate). Among the rows that are not deleted:
 *  1. a company name, case and spaces around not counted: «ООО Ромашка» = «ооо ромашка » (the index was on
 *     the name as typed);
 *  2. a user e-mail, the same way (contacts and staff share it: the e-mail is the login and the address
 *     the mail of a contact is matched by); contact e-mails are stored in lower case (helper/phone.ts
 *     normalizeEmail), "" becomes none;
 *  3. the ИНН of a company, when filled (stored as digits; "305 123 456" becomes "305123456").
 * Rows are only cleaned where the clean value takes nobody's place. When live duplicates exist, that one
 * index is NOT created and the duplicates are listed in the log of the migration: they are merged by hand
 * («Объединить контакты», or the trash of companies), then the migration of a later release adds it.
 * `down` puts the old indexes back (the cleaned values stay cleaned).
 */
export class PeopleUnique1795630000000 implements MigrationInterface {
  name = 'PeopleUnique1795630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------------------------------------ data: the stored forms
    await queryRunner.query(
      `UPDATE "user" SET email = NULL WHERE role = 'ctr_agent' AND email IS NOT NULL AND btrim(email) = ''`,
    );
    await queryRunner.query(`
      UPDATE "user" u SET email = lower(btrim(u.email))
       WHERE u.role = 'ctr_agent' AND u.email IS NOT NULL AND u.email <> lower(btrim(u.email))
         AND (u.deleted_at IS NOT NULL OR NOT EXISTS (
               SELECT 1 FROM "user" x WHERE x.id <> u.id AND x.deleted_at IS NULL
                  AND lower(btrim(x.email)) = lower(btrim(u.email))))`);
    await queryRunner.query(`UPDATE company SET email = NULL WHERE email IS NOT NULL AND btrim(email) = ''`);
    await queryRunner.query(
      `UPDATE company SET email = lower(btrim(email)) WHERE email IS NOT NULL AND email <> lower(btrim(email))`,
    );
    await queryRunner.query(`
      UPDATE company c SET name = btrim(c.name)
       WHERE c.name <> btrim(c.name) AND btrim(c.name) <> ''
         AND (c.deleted_at IS NOT NULL OR NOT EXISTS (
               SELECT 1 FROM company x WHERE x.id <> c.id AND x.deleted_at IS NULL AND x.name = btrim(c.name)))`);
    await queryRunner.query(`UPDATE company SET inn = NULL WHERE inn IS NOT NULL AND btrim(inn) = ''`);
    // "305 123 456", "305-123-456": digits; text that is not a number (letters) stays as typed
    await queryRunner.query(`
      UPDATE company SET inn = regexp_replace(inn, '[^0-9]', '', 'g')
       WHERE inn IS NOT NULL AND inn ~ '[^0-9]' AND inn ~ '^[0-9 .-]+$'
         AND length(regexp_replace(inn, '[^0-9]', '', 'g')) BETWEEN 9 AND 20`);

    // ------------------------------------------------------------ the unique indexes
    await this.replaceIndex(
      queryRunner,
      'IDX_company_name_live',
      `SELECT lower(btrim(name)) AS value, string_agg(id::text || ' «' || name || '»', ', ' ORDER BY id) AS rows
         FROM company WHERE deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1`,
      `CREATE UNIQUE INDEX "IDX_company_name_live" ON "company" (lower(btrim("name"))) WHERE "deleted_at" IS NULL`,
      'company names',
    );
    await this.replaceIndex(
      queryRunner,
      'IDX_user_email_active',
      `SELECT lower(btrim(email)) AS value, string_agg(id::text || ' ' || role || ' «' || username || '»', ', ' ORDER BY id) AS rows
         FROM "user" WHERE deleted_at IS NULL AND email IS NOT NULL GROUP BY 1 HAVING count(*) > 1`,
      `CREATE UNIQUE INDEX "IDX_user_email_active" ON "user" (lower(btrim("email"))) WHERE "deleted_at" IS NULL AND "email" IS NOT NULL`,
      'user e-mails',
    );
    await this.replaceIndex(
      queryRunner,
      'IDX_company_inn_live',
      `SELECT inn AS value, string_agg(id::text || ' «' || name || '»', ', ' ORDER BY id) AS rows
         FROM company WHERE deleted_at IS NULL AND inn IS NOT NULL GROUP BY 1 HAVING count(*) > 1`,
      `CREATE UNIQUE INDEX "IDX_company_inn_live" ON "company" ("inn") WHERE "deleted_at" IS NULL AND "inn" IS NOT NULL`,
      'company ИНН',
    );
  }

  /** The new index instead of the old one of the same name, unless the data has duplicates (then logged). */
  private async replaceIndex(
    queryRunner: QueryRunner,
    name: string,
    duplicatesSql: string,
    createSql: string,
    what: string,
  ): Promise<void> {
    const duplicates: { value: string; rows: string }[] = await queryRunner.query(duplicatesSql);
    if (duplicates.length) {
      console.warn(
        `[${this.name}] ${name} not changed: duplicate ${what} among live rows — ` +
          duplicates.map((d) => `"${d.value}": ${d.rows}`).join('; '),
      );
      return;
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    await queryRunner.query(createSql);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_company_inn_live"`);
    // the indexes of 1795240000000-user-email-active and 1795230000000-people-phones (fail if the data
    // has rows that differ in case only by then)
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_email_active"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_user_email_active" ON "user" ("email") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_company_name_live"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_company_name_live" ON "company" ("name") WHERE "deleted_at" IS NULL`,
    );
  }
}
