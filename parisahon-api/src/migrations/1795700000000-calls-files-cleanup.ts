import { MigrationInterface, QueryRunner } from 'typeorm';
import { statSync } from 'fs';
import { basename, join } from 'path';

/**
 * Calls and files (fix wave 1b):
 *  - recorder_token.tls_required: FTP logins with this token must use FTPS (the FTP receiver asks
 *    GET /calls/recorder; set per token on the settings page);
 *  - the files of Telegram / WhatsApp messages saved before the source was written: every row without
 *    an e-mail still had the column's default "from_emails" (the list said «Почта» and the filter
 *    «Сообщение» did not find them) — a file of an e-mail always has email_id (deleted with the e-mail),
 *    so a row without one is a file of a message;
 *  - their extension from the name on disk, and the size of every row with size 0 from the file on disk
 *    (the messengers never wrote it; a file that is not on the disk keeps 0, shown as «—»).
 */
export class CallsFilesCleanup1795700000000 implements MigrationInterface {
  name = 'CallsFilesCleanup1795700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "recorder_token" ADD COLUMN IF NOT EXISTS "tls_required" boolean NOT NULL DEFAULT false`);

    // a file of a note (NEW_COMMENT = 5 holds it in after_state.data.files) is a comment's, the rest a message's
    await queryRunner.query(
      `UPDATE "file" f SET "from" = 'from_comments'
        WHERE f."email_id" IS NULL AND f."from" = 'from_emails'
          AND EXISTS (SELECT 1 FROM "event" e WHERE e."type" = 5
                         AND e."after_state"->'data'->'files' @> jsonb_build_array(jsonb_build_object('path', f."path")))`,
    );
    await queryRunner.query(`UPDATE "file" SET "from" = 'from_messages' WHERE "email_id" IS NULL AND "from" = 'from_emails'`);
    await queryRunner.query(
      `UPDATE "file" SET "extension" = lower(substring("path" from '(\\.[A-Za-z0-9]{1,16})$'))
        WHERE "extension" IS NULL AND "path" ~ '\\.[A-Za-z0-9]{1,16}$'`,
    );

    // the same folder as FileService.UPLOADS_DIR (dist/migrations -> public/uploads)
    const uploads = join(__dirname, '..', '..', 'public', 'uploads');
    const rows: { id: number; path: string }[] = await queryRunner.query(
      `SELECT "id", "path" FROM "file" WHERE "size" = 0 AND COALESCE("path", '') <> ''`,
    );
    for (const row of rows) {
      let size = 0;
      try {
        size = statSync(join(uploads, basename(row.path))).size;
      } catch {
        continue;
      }
      if (size > 0) await queryRunner.query(`UPDATE "file" SET "size" = $1 WHERE "id" = $2`, [size, row.id]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // the sources, extensions and sizes stay corrected
    await queryRunner.query(`ALTER TABLE "recorder_token" DROP COLUMN IF EXISTS "tls_required"`);
  }
}
