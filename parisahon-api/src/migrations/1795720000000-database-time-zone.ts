import { MigrationInterface, QueryRunner } from 'typeorm';
import { APP_TIME_ZONE, knownTimeZone } from '../helper/time-zone';

/**
 * DB-1 / HACK-3 / SEC-17: the database's own default zone is the CRM's zone (helper/time-zone.ts: TZ,
 * Asia/Tashkent by default), so psql, the backups, the ops scripts and any connection that does not set a
 * zone see the times as the API does. The API's connections set the same zone themselves (datasource.ts).
 *
 * Only the setting changes, no row is moved: the servers had Asia/Karachi (set by hand on 2026-11-21, the
 * same UTC+5), the rows of before the crm2 switch are test data that will be wiped, and
 * TimeZone1794960000000 does nothing. Running it again changes nothing.
 * ALTER DATABASE needs the owner of the database (the API's role on every server); a role that is not
 * the owner gets a warning instead of a failed deploy, and the schema check shows the difference.
 */
export class DatabaseTimeZone1795720000000 implements MigrationInterface {
  name = 'DatabaseTimeZone1795720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await setDatabaseZone(queryRunner, APP_TIME_ZONE);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // what the servers had before
    await setDatabaseZone(queryRunner, 'Asia/Karachi');
  }
}

async function setDatabaseZone(queryRunner: QueryRunner, zone: string): Promise<void> {
  // a checked name only (letters, digits, / _ + -): it is written into the statement
  const name = knownTimeZone(zone);
  if (!name) throw new Error(`Unknown time zone: ${zone}`);
  await queryRunner.query(`DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), '${name}');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'The time zone of database % is not changed (%): run as its owner ALTER DATABASE % SET timezone TO ''${name}''',
    current_database(), SQLERRM, current_database();
END $$`);
}
