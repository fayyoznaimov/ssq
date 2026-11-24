import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-16: the foreign keys the CRM looks up by, or that a delete has to check, get their index; two indexes
 * that a wider one already covers go. Built CONCURRENTLY: writes to the tables go on meanwhile.
 *
 *  - task."createdById" (the desktop: tasks I gave), task.ctr_agent_id (tasks of a contact; the check when
 *    a contact is deleted), task.group_id of open tasks (the group's tasks in the bot and the reminders);
 *  - deal_stage_record (stage_id, created_at): time in a stage, the stage reports;
 *  - deal_product.product_id: the check when a product is deleted (ON DELETE RESTRICT, 1795721000000);
 *  - file.uploaded_by (the desktop), company.primary_contact_id (the company of a contact),
 *    email.sent_by_id (the mailbox: letters I sent);
 *  - gone: event (type), covered by IDX_event_type_created (type, created_at); call_upload (user_id),
 *    covered by IDX_call_upload_hash (user_id, file_hash).
 * The entities declare them (synchronize: false), so TypeORM leaves them alone.
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction, and `transaction = false` on a migration makes
 * `typeorm migration:run` in its default mode "all" (what every deploy script runs) refuse the whole run
 * (ForbiddenTransactionModeOverrideError). So this migration steps out of the transaction TypeORM opened:
 * it commits what the migrations before it did, builds the indexes, and opens a new transaction in which
 * TypeORM records it and goes on. An index a broken earlier run left invalid is built again. Running it
 * again changes nothing.
 */
const INDEXES: { name: string; table: string; definition: string }[] = [
  { name: 'IDX_task_created_by', table: 'task', definition: '("createdById")' },
  { name: 'IDX_task_ctr_agent', table: 'task', definition: '("ctr_agent_id")' },
  { name: 'IDX_task_open_group', table: 'task', definition: '("group_id") WHERE "closed_at" IS NULL' },
  { name: 'IDX_deal_stage_record_stage', table: 'deal_stage_record', definition: '("stage_id", "created_at")' },
  { name: 'IDX_deal_product_product', table: 'deal_product', definition: '("product_id")' },
  { name: 'IDX_file_uploaded_by', table: 'file', definition: '("uploaded_by")' },
  { name: 'IDX_company_primary_contact', table: 'company', definition: '("primary_contact_id")' },
  { name: 'IDX_email_sent_by', table: 'email', definition: '("sent_by_id")' },
];

/** covered by a wider index with the same first column */
const REDUNDANT: { name: string; table: string; definition: string }[] = [
  { name: 'IDX_b8c3aeeac35ace9d387fb5e142', table: 'event', definition: '("type")' },
  { name: 'IDX_call_upload_user', table: 'call_upload', definition: '("user_id")' },
];

export class KeyIndexes1795724000000 implements MigrationInterface {
  name = 'KeyIndexes1795724000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await outsideTransaction(queryRunner, async () => {
      for (const index of INDEXES) await createConcurrently(queryRunner, index);
      for (const index of REDUNDANT) await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await outsideTransaction(queryRunner, async () => {
      for (const index of REDUNDANT) await createConcurrently(queryRunner, index);
      for (const index of INDEXES) await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    });
  }
}

/** Runs `work` with no transaction open (see above), then gives TypeORM its transaction back. */
async function outsideTransaction(queryRunner: QueryRunner, work: () => Promise<void>): Promise<void> {
  const inTransaction = queryRunner.isTransactionActive;
  if (inTransaction) await queryRunner.commitTransaction();
  try {
    await work();
  } finally {
    if (inTransaction) await queryRunner.startTransaction();
  }
}

async function createConcurrently(
  queryRunner: QueryRunner,
  index: { name: string; table: string; definition: string },
): Promise<void> {
  // a CONCURRENTLY build that failed leaves an invalid index with the name: IF NOT EXISTS would keep it
  const [invalid] = await queryRunner.query(
    `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace AND NOT i.indisvalid`,
    [index.name],
  );
  if (invalid) await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
  await queryRunner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ON "${index.table}" ${index.definition}`);
}
