import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mail (review wave 1):
 *  - email.from_name, in_reply_to, reference_ids, html: the sender's name, the thread headers and the
 *    HTML part of received letters (MAIL-11, MAIL-12, MAIL-16, MAIL-18);
 *  - email.deleted_by_id: who deleted a letter in the CRM (it is moved to the Trash mailbox now, MAIL-10);
 *  - email_transporter.verified_at: the mail server accepted the address and password (MAIL-6);
 *  - IDX_event_email_id: the history entries of a letter (its deals in the mail list, the agent's
 *    view of the letters of their deals);
 *  - data: attachments of letters already in a deal's history go to the deal's files (MAIL-17,
 *    small images of signatures left out), and stored letters of a known contact point to the
 *    contact (MAIL-4: a client whose deals were all closed was not found).
 */
export class MailThreads1795260000000 implements MigrationInterface {
  name = 'MailThreads1795260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "email"
        ADD COLUMN IF NOT EXISTS "from_name" character varying(255),
        ADD COLUMN IF NOT EXISTS "in_reply_to" character varying(998),
        ADD COLUMN IF NOT EXISTS "reference_ids" text,
        ADD COLUMN IF NOT EXISTS "html" text,
        ADD COLUMN IF NOT EXISTS "deleted_by_id" integer
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_email_deleted_by') THEN
          ALTER TABLE "email" ADD CONSTRAINT "FK_email_deleted_by" FOREIGN KEY ("deleted_by_id")
            REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$
    `);
    await queryRunner.query(`ALTER TABLE "email_transporter" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMP`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_event_email_id" ON "event" ((("after_state" -> 'data') ->> 'id')) WHERE "type" = 9`,
    );

    // MAIL-17: received attachments were never linked to the deal the letter is in (sent ones were)
    await queryRunner.query(`
      INSERT INTO "deal_file" ("fileId", "dealId")
      SELECT DISTINCT f.id, e.deal_id
        FROM "event" e
        JOIN "file" f ON f.email_id::text = (e.after_state -> 'data') ->> 'id'
        JOIN "deal" d ON d.id = e.deal_id
       WHERE e.type = 9
         AND e.deal_id IS NOT NULL
         AND NOT (ltrim(lower(COALESCE(f.extension, '')), '.') IN ('png', 'jpg', 'jpeg', 'gif', 'bmp') AND f.size < 20480)
      ON CONFLICT DO NOTHING
    `);

    // MAIL-4: letters of a contact that sync did not recognise (all of their deals were closed)
    await queryRunner.query(`
      UPDATE "email" e
         SET user_id = c.id
        FROM (SELECT DISTINCT ON (lower(u.email)) u.id, lower(u.email) AS address
                FROM "user" u
               WHERE u.role = 'ctr_agent' AND u.deleted_at IS NULL AND COALESCE(u.email, '') <> ''
               ORDER BY lower(u.email), u.id) c
       WHERE e.user_id IS NULL
         AND e.outgoing = false
         AND lower(e."from") = c.address
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_email_id"`);
    await queryRunner.query(`ALTER TABLE "email_transporter" DROP COLUMN IF EXISTS "verified_at"`);
    await queryRunner.query(`ALTER TABLE "email" DROP CONSTRAINT IF EXISTS "FK_email_deleted_by"`);
    await queryRunner.query(`
      ALTER TABLE "email"
        DROP COLUMN IF EXISTS "deleted_by_id",
        DROP COLUMN IF EXISTS "html",
        DROP COLUMN IF EXISTS "reference_ids",
        DROP COLUMN IF EXISTS "in_reply_to",
        DROP COLUMN IF EXISTS "from_name"
    `);
  }
}
