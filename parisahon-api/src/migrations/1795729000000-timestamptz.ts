import { MigrationInterface, QueryRunner } from 'typeorm';
import { APP_TIME_ZONE, knownTimeZone } from '../helper/time-zone';

/**
 * DB-1 / HACK-3: every time of the CRM is stored with its zone (timestamp with time zone), so it means the
 * same moment whatever zone a connection, psql, a backup or a script works in. The 60 columns below were
 * `timestamp without time zone` (the 7 newer ones of control_notice, telegram_remote_file, messenger_*,
 * phone_original and audit_log already are timestamptz).
 *
 * A stored value is the local time of the CRM's zone (helper/time-zone.ts: TZ, Asia/Tashkent by default):
 * the API and its database sessions have written local UTC+5 time since the crm2 switch of 2026-11-21
 * (Asia/Karachi then, the same offset), so `value AT TIME ZONE '<zone>'` keeps every such moment.
 * Rows of before the switch are test data in two zones and will be wiped: they are not told apart.
 * The JSON of the API does not change (the driver gave the same Date objects), a raw `col::date` or
 * `date_trunc` works in the session's zone as before. The entities say `timestamp with time zone`.
 * Each table is rewritten once (one ALTER TABLE per table, its indexes rebuilt): a short exclusive lock per
 * table, a database of the CRM's size takes seconds. A busy table makes it fail fast (lock_timeout) instead
 * of queueing the API behind it. Running it again changes nothing (only columns still without a zone).
 * Separate from the other migrations of DB-1 so it can be deployed (or not) on its own: without it the entities
 * must say `timestamp` again (the list of files is in the report of the fix).
 */
const COLUMNS: Record<string, string[]> = {
  ai_job: ['created_at', 'run_after', 'started_at', 'finished_at'],
  ai_usage: ['paused_until'],
  bot_account: ['linked_at'],
  bot_link_code: ['expires_at'],
  bot_reminder: ['sent_at', 'start_time'],
  call_upload: ['received_at', 'recorded_at', 'processed_at'],
  collection: ['created_at'],
  company: ['created_at', 'updated_at', 'deleted_at'],
  company_filler: ['created_at'],
  conversation_item: ['created_at', 'due_at', 'closed_at', 'tasked_at'],
  conversation_turn: ['created_at', 'client_at', 'answered_at'],
  deal: ['created_at', 'closed_at', 'deleted_at', 'last_stage_change'],
  deal_filler: ['created_at'],
  deal_stage: ['created_at'],
  deal_stage_record: ['created_at'],
  email: ['sent_at', 'deleted_at'],
  email_read: ['read_at'],
  email_transporter: ['created_at', 'verified_at'],
  event: ['created_at', 'replied_at'],
  file: ['created_at'],
  filler: ['created_at'],
  group: ['created_at'],
  product: ['created_at', 'deleted_at'],
  product_filler: ['created_at'],
  recorder_token: ['created_at', 'revoked_at', 'last_upload_at'],
  recording: ['created_at'],
  task: ['created_at', 'start_time', 'end_time', 'closed_at'],
  trigger: ['created_at'],
  trigger_run: ['created_at', 'run_at', 'executed_at'],
  user: ['created_at', 'updated_at', 'deleted_at'],
  user_filler: ['created_at'],
};

export class Timestamptz1795729000000 implements MigrationInterface {
  name = 'Timestamptz1795729000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await convert(queryRunner, 'timestamp without time zone', 'timestamp with time zone');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await convert(queryRunner, 'timestamp with time zone', 'timestamp without time zone');
  }
}

/**
 * Both ways `AT TIME ZONE '<zone>'`: a local time becomes the moment it was in the zone, a moment becomes
 * the local time of the zone. Only the columns that still have the `from` type are changed.
 */
async function convert(queryRunner: QueryRunner, from: string, to: string): Promise<void> {
  const zone = knownTimeZone(APP_TIME_ZONE);
  if (!zone) throw new Error(`Unknown time zone: ${APP_TIME_ZONE}`);
  await queryRunner.query(`SET LOCAL lock_timeout = '20s'`);
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const rows: { column_name: string }[] = await queryRunner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[]) AND data_type = $3`,
      [table, columns, from],
    );
    if (!rows.length) continue;
    const changes = rows.map(
      ({ column_name }) => `ALTER COLUMN "${column_name}" TYPE ${to} USING "${column_name}" AT TIME ZONE '${zone}'`,
    );
    await queryRunner.query(`ALTER TABLE "${table}" ${changes.join(', ')}`);
  }
  await queryRunner.query(`SET LOCAL lock_timeout = DEFAULT`);
}
