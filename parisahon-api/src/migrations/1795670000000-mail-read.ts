import * as fs from 'fs';
import { join } from 'path';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mail (fix wave 1b):
 *  - email_read: «прочитано» per staff member (MAIL-10). Letters read so far stay read for every
 *    current staff member, so that nobody suddenly gets the whole mailbox as unread.
 *  - A letter in the history of a deal once (MAIL-15): the second NEW_EMAIL entry of the same
 *    Message-ID in a deal (a letter delivered twice) goes.
 *  - One To / Cc row per address (MAIL-18): `"A" <a@x>, b@y` used to be one row, so the filter by a
 *    manager's address did not find letters with several recipients.
 *  - Letters of colleagues (our domain) that reached INBOX / Spam and are addressed only to our
 *    addresses are incoming, not «Отправленные» (MAIL-18); their history entries too.
 *  - Files of letters sent from the CRM saved with size 0 get their size from the disk (MAIL-16).
 *  - Client messages "answered" by the client's own letter (it used to be outgoing) are unanswered
 *    again, so that the control report and the reply times count the real answers (OMNI-4).
 * Idempotent: runs on the production copy as it is.
 */
export class MailRead1795670000000 implements MigrationInterface {
  name = 'MailRead1795670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_read" (
        "email_id" integer NOT NULL,
        "user_id" integer NOT NULL,
        "read_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_read" PRIMARY KEY ("email_id", "user_id")
      )
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_email_read_email') THEN
          ALTER TABLE "email_read" ADD CONSTRAINT "FK_email_read_email" FOREIGN KEY ("email_id")
            REFERENCES "email"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_email_read_user') THEN
          ALTER TABLE "email_read" ADD CONSTRAINT "FK_email_read_user" FOREIGN KEY ("user_id")
            REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_email_read_user" ON "email_read" ("user_id")`);

    // MAIL-10: what was read stays read for the staff of today
    await queryRunner.query(`
      INSERT INTO "email_read" ("email_id", "user_id")
      SELECT e.id, u.id
        FROM "email" e
        CROSS JOIN "user" u
       WHERE e.read = true AND u.role <> 'ctr_agent' AND u.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `);

    // MAIL-15: one entry per letter (Message-ID) and deal
    await queryRunner.query(`
      DELETE FROM "event" e
       USING (
         SELECT id, row_number() OVER (
                  PARTITION BY deal_id, (after_state -> 'data') ->> 'message_id' ORDER BY id) AS n
           FROM "event"
          WHERE type = 9 AND deal_id IS NOT NULL
            AND COALESCE((after_state -> 'data') ->> 'message_id', '') <> ''
       ) d
       WHERE e.id = d.id AND d.n > 1
    `);

    // MAIL-18: one row per address
    for (const table of ['email_to', 'email_cc']) {
      const rows: { id: number; email_id: number; value: string }[] = await queryRunner.query(
        `SELECT id, email_id, value FROM "${table}" WHERE value ~ '@[^,;]*[,;].*@' ORDER BY id`,
      );
      for (const row of rows) {
        const parts = splitHeader(row.value);
        if (parts.length < 2) continue;
        await queryRunner.query(`UPDATE "${table}" SET value = $1 WHERE id = $2`, [parts[0], row.id]);
        for (const part of parts.slice(1)) {
          await queryRunner.query(`INSERT INTO "${table}" (email_id, value) VALUES ($1, $2)`, [row.email_id, part]);
        }
      }
    }

    // MAIL-18: a colleague's letter that reached the shared INBOX (not Sent, not sent from the CRM)
    // and has no recipient outside our domain is an incoming letter
    const shared = String(process.env.EMAIL_DEFAULT_USER ?? '').toLowerCase();
    const sharedDomain = shared.includes('@') ? shared.slice(shared.lastIndexOf('@') + 1) : 'parisahome.com';
    const sent = process.env.EMAIL_SENT_MAILBOX || 'INBOX.Sent';
    const internal: { id: number }[] = await queryRunner.query(
      `SELECT e.id FROM "email" e
        WHERE e.outgoing = true AND e.sent_by_id IS NULL AND e.from_mailbox <> $1
          AND NOT EXISTS (
            SELECT 1 FROM (SELECT value FROM "email_to" WHERE email_id = e.id
                           UNION ALL SELECT value FROM "email_cc" WHERE email_id = e.id) r,
                   LATERAL regexp_matches(lower(r.value), '[a-z0-9._%+''-]+@([a-z0-9-]+(\\.[a-z0-9-]+)+)', 'g') AS m
             WHERE m[1] NOT IN ('parisahome.com', $2))`,
      [sent, sharedDomain],
    );
    const ids = internal.map((row) => Number(row.id));
    if (ids.length) {
      await queryRunner.query(`UPDATE "email" SET outgoing = false WHERE id = ANY($1)`, [ids]);
      await queryRunner.query(
        `UPDATE "event"
            SET outgoing = false,
                after_state = jsonb_set(after_state, '{data,outgoing}', 'false'::jsonb)
          WHERE type = 9 AND (after_state -> 'data') ->> 'id' = ANY($1)`,
        [ids.map(String)],
      );
    }

    // OMNI-4: a client's own letter used to be taken for the manager's answer (its event was
    // "outgoing"): the messages "answered" at the very moment of an incoming letter, with no answer
    // of ours then, are unanswered again; ControlService.fillRepliedAt finds their real answer.
    await queryRunner.query(`
      UPDATE "event" c SET replied_at = NULL
       WHERE c.replied_at IS NOT NULL AND c.outgoing = false AND c.deal_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM "event" m
                      WHERE m.deal_id = c.deal_id AND m.type = 9 AND m.outgoing = false AND m.created_at = c.replied_at)
         AND NOT EXISTS (SELECT 1 FROM "event" a
                          WHERE a.deal_id = c.deal_id AND a.outgoing = true AND a.created_at = c.replied_at)
    `);

    // MAIL-16: sizes of files sent from the CRM before the size was kept
    const uploads = join(__dirname, '..', '..', 'public', 'uploads');
    const empty: { id: number; path: string }[] = await queryRunner.query(
      `SELECT f.id, f.path FROM "file" f WHERE f.email_id IS NOT NULL AND COALESCE(f.size, 0) = 0`,
    );
    for (const file of empty) {
      try {
        const size = fs.statSync(join(uploads, String(file.path))).size;
        if (size > 0) await queryRunner.query(`UPDATE "file" SET size = $1 WHERE id = $2`, [size, file.id]);
      } catch {
        // not on this disk (a copy of the database without the files): left as it is
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "email_read"`);
  }
}

/** `"Ivan, Petrov" <a@x>, b@y; c@z` -> the addresses one by one, as written (quotes respected). */
function splitHeader(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const ch of String(value ?? '')) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter((part) => part.includes('@'));
}
