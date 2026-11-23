import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Calls by number: the «Звонки» tab of a company card finds the recordings whose number ends with the
 * same 9 digits as a phone of the company or of its contacts (CallsService.companyCalls). Without this
 * index every recording's number was cleaned with a regular expression on each request.
 * Declared on the entity (Recording, synchronize: false: an expression index).
 */
export class CallNumberIndex1795290000000 implements MigrationInterface {
  name = 'CallNumberIndex1795290000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recording_number_tail" ON "recording" (right(regexp_replace(COALESCE("from_number", ''), '[^0-9]', '', 'g'), 9))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_recording_number_tail"`);
  }
}
