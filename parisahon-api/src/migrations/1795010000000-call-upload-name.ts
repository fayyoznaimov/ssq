import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Call recordings from any recorder (the FTP receiver, parisahon-ftp):
 *  - call_upload.file_hash — SHA-256 of the received file: the same file of the same manager is
 *    not queued twice (sync apps upload again after a reinstall);
 *  - call_upload.recorded_at — the moment of the call (from the name of the file or its time);
 *  - call_upload.caller_name — the name from the manager's phone book, when the file has no number.
 * Declared on the entity (CallUpload).
 */
export class CallUploadName1795010000000 implements MigrationInterface {
  name = 'CallUploadName1795010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "call_upload" ADD "file_hash" character varying(64)`);
    await queryRunner.query(`ALTER TABLE "call_upload" ADD "recorded_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "call_upload" ADD "caller_name" character varying(255)`);
    await queryRunner.query(`CREATE INDEX "IDX_call_upload_hash" ON "call_upload" ("user_id", "file_hash")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_call_upload_hash"`);
    await queryRunner.query(`ALTER TABLE "call_upload" DROP COLUMN "caller_name"`);
    await queryRunner.query(`ALTER TABLE "call_upload" DROP COLUMN "recorded_at"`);
    await queryRunner.query(`ALTER TABLE "call_upload" DROP COLUMN "file_hash"`);
  }
}
