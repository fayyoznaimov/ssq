import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One messenger message = one row (DB-6, messenger/message-key.ts): the key is the manager's account,
 * the chat (the client) and the message id.
 *  - account = user_id of an outgoing message, target_user_id of an incoming one; chat = the other;
 *  - Telegram (event type 12): tg_message_id; WhatsApp (type 16): external_id.
 *
 * Before wave 1 a message was copied into every open deal of the client: those copies are removed
 * here (the first row of each key stays — the copy in the client's newest deal, since the copies were
 * written newest deal first). Rows that differ in any part of the key are never touched. Their
 * «клиент ждёт ответа» notices (control_notice) go with them (ON DELETE CASCADE).
 * Then the unique partial indexes hold the key, so a parallel second delivery cannot store it again.
 * down() drops the indexes only (the removed copies are not restored).
 */
const ACCOUNT = '(CASE WHEN "outgoing" THEN "user_id" ELSE "target_user_id" END)';
const CHAT = '(CASE WHEN "outgoing" THEN "target_user_id" ELSE "user_id" END)';

const KEYS: { index: string; type: number; id: string }[] = [
  { index: 'IDX_event_tg_message_key', type: 12, id: '"tg_message_id"' },
  { index: 'IDX_event_wa_message_key', type: 16, id: '"external_id"' },
];

export class MessengerMessageKey1795680000000 implements MigrationInterface {
  name = 'MessengerMessageKey1795680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const key of KEYS) {
      await queryRunner.query(
        `DELETE FROM "event" e USING (
           SELECT id, row_number() OVER (PARTITION BY ${ACCOUNT}, ${CHAT}, ${key.id} ORDER BY id) AS n
             FROM "event"
            WHERE "type" = ${key.type} AND ${key.id} IS NOT NULL AND ${ACCOUNT} IS NOT NULL AND ${CHAT} IS NOT NULL
         ) copies
         WHERE e.id = copies.id AND copies.n > 1`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${key.index}" ON "event" (${ACCOUNT}, ${CHAT}, ${key.id})
          WHERE "type" = ${key.type} AND ${key.id} IS NOT NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const key of KEYS) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${key.index}"`);
    }
  }
}
