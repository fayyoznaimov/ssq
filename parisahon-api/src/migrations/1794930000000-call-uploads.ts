import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Call recordings through the API (src/calls): recorder tokens of the managers
 * and the queue of received files.
 */
export class CallUploads1794930000000 implements MigrationInterface {
  name = 'CallUploads1794930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recorder_token" (
        "id" SERIAL NOT NULL,
        "user_id" integer NOT NULL,
        "token_hash" character varying(64) NOT NULL,
        "created_by" integer,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP,
        "last_upload_at" TIMESTAMP,
        CONSTRAINT "PK_recorder_token" PRIMARY KEY ("id"),
        CONSTRAINT "FK_recorder_token_user" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_recorder_token_created_by" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_recorder_token_hash" ON "recorder_token" ("token_hash")`);
    await queryRunner.query(`
      CREATE TABLE "call_upload" (
        "id" SERIAL NOT NULL,
        "user_id" integer NOT NULL,
        "file_name" character varying(255) NOT NULL,
        "raw_path" character varying(255) NOT NULL,
        "duration" bigint,
        "from_number" character varying(64),
        "outgoing" boolean NOT NULL DEFAULT true,
        "source" character varying(32) NOT NULL DEFAULT 'recorder',
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "error" text,
        "recording_id" integer,
        "received_at" TIMESTAMP NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMP,
        CONSTRAINT "PK_call_upload" PRIMARY KEY ("id"),
        CONSTRAINT "FK_call_upload_user" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_call_upload_recording" FOREIGN KEY ("recording_id") REFERENCES "recording"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_call_upload_status" ON "call_upload" ("status", "received_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "call_upload"`);
    await queryRunner.query(`DROP TABLE "recorder_token"`);
  }
}
