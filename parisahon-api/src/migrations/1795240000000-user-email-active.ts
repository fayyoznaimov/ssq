import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * user.email was unique over every row, the soft-deleted ones included. The API checks for a taken
 * e-mail among existing accounts only, so the e-mail of a deleted employee or contact could not be
 * used again (500 on save), and the API did not start at all once the seed admin from .env had been
 * deleted (the seed inserted it again and hit the index). Now the e-mail is unique among the rows
 * that are not deleted. The new index is created while the old one still holds, so it cannot fail on
 * existing data.
 */
export class UserEmailActive1795240000000 implements MigrationInterface {
  name = 'UserEmailActive1795240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_email_active" ON "user" ("email") WHERE "deleted_at" IS NULL`,
    );
    // the full unique index (migration 1710016292238; the same name when TypeORM synchronised it), by its definition
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
          WHERE n.nspname = current_schema() AND t.relname = 'user' AND x.indisunique AND NOT x.indisprimary
            AND x.indnatts = 1 AND x.indpred IS NULL AND x.indexprs IS NULL AND a.attname = 'email'
            AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
        LOOP
          EXECUTE format('DROP INDEX %I.%I', current_schema(), idx.name);
        END LOOP;
        -- ... or a unique constraint on the column, should a database have one instead
        FOR idx IN
          SELECT c.conname AS name
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
          WHERE n.nspname = current_schema() AND t.relname = 'user' AND c.contype = 'u'
            AND array_length(c.conkey, 1) = 1 AND a.attname = 'email'
        LOOP
          EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', current_schema(), 'user', idx.name);
        END LOOP;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // fails if the e-mail of a deleted account has been given to a new one meanwhile
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_e12875dfb3b1d92d7d7c5377e2" ON "user" ("email")`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_email_active"`);
  }
}
