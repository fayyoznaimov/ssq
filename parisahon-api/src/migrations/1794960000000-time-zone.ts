import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Does nothing, on purpose (DB-1 / HACK-3 / SEC-17).
 *
 * This migration used to set the database zone to Asia/Karachi and move 30 columns of every row from
 * UTC into that zone. On the servers it was recorded as applied (migrations id 29) without its body
 * ever running, and the API has written local time since the crm2 switch of 2026-11-21: running the
 * old body now (a database without this row, a restore, a rerun) would move every newer row 5 hours.
 * The rows of before the switch are test data that will be wiped, so nothing is shifted any more.
 * The database zone is set by 1795720000000-database-time-zone (TZ, Asia/Tashkent by default), and
 * 1795729000000-timestamptz stores the times with their zone.
 * The class and its name stay: TypeORM keeps finding the recorded row.
 */
export class TimeZone1794960000000 implements MigrationInterface {
  name = 'TimeZone1794960000000';

  public async up(_queryRunner: QueryRunner): Promise<void> {
    // nothing: see above
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // nothing: up() changes nothing
  }
}
