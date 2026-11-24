import { MigrationInterface, QueryRunner } from 'typeorm';

type Rule = 'RESTRICT' | 'SET NULL' | 'CASCADE' | 'NO ACTION';

/**
 * DB-3: a DELETE of one row no longer silently destroys business data through ON DELETE CASCADE.
 *
 *  - The values of a custom field (company_filler, deal_filler, user_filler, product_filler): RESTRICT.
 *    DELETE /fillers/:id deletes the values itself, after the web showed how many there are
 *    (GET /fillers/:id/usage); a DELETE of a field by any other way is refused while it has values.
 *  - A product in deals (deal_product.product_id): RESTRICT — products are deleted softly by the CRM.
 *  - The attachments of a letter (file.email_id): RESTRICT — letters are deleted softly; an attachment is
 *    also a file of its deal (deal_file), and it disappeared from the deal with the letter.
 *  - Call recordings and the upload queue of an employee (recording.user_id, call_upload.user_id): RESTRICT —
 *    employees are deleted softly; their recordings stay.
 *  - The contacts of a company ("user".company_id): SET NULL — a company removed for good leaves its
 *    contacts without a company instead of taking them with it.
 *  - The person of a trigger (trigger.user_id, not used by the current triggers): SET NULL instead of
 *    deleting the trigger with the person.
 * What a row owns goes with it as before (the values of a company, the lines of a deal, a letter's
 * recipients, a trigger's runs ...): those cascades are the purge of the deal trash and are left alone.
 * The constraint keeps its name (TypeORM and the schema check compare by name and rule). Running it again
 * changes nothing.
 */
const RULES: { table: string; column: string; ref: string; rule: Rule; before: Rule }[] = [
  { table: 'company_filler', column: 'filler_id', ref: 'filler', rule: 'RESTRICT', before: 'CASCADE' },
  { table: 'deal_filler', column: 'filler_id', ref: 'filler', rule: 'RESTRICT', before: 'CASCADE' },
  { table: 'user_filler', column: 'filler_id', ref: 'filler', rule: 'RESTRICT', before: 'CASCADE' },
  { table: 'product_filler', column: 'filler_id', ref: 'filler', rule: 'RESTRICT', before: 'CASCADE' },
  { table: 'deal_product', column: 'product_id', ref: 'product', rule: 'RESTRICT', before: 'CASCADE' },
  { table: 'file', column: 'email_id', ref: 'email', rule: 'RESTRICT', before: 'CASCADE' },
  { table: 'recording', column: 'user_id', ref: 'user', rule: 'RESTRICT', before: 'CASCADE' },
  { table: 'call_upload', column: 'user_id', ref: 'user', rule: 'RESTRICT', before: 'CASCADE' },
  { table: 'user', column: 'company_id', ref: 'company', rule: 'SET NULL', before: 'CASCADE' },
  { table: 'trigger', column: 'user_id', ref: 'user', rule: 'SET NULL', before: 'CASCADE' },
];

export class DeleteRules1795721000000 implements MigrationInterface {
  name = 'DeleteRules1795721000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const r of RULES) await setDeleteRule(queryRunner, r.table, r.column, r.ref, r.rule);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const r of RULES) await setDeleteRule(queryRunner, r.table, r.column, r.ref, r.before);
  }
}

/**
 * The foreign key of table(column) -> ref(id) gets the rule; its name stays (one is made when it is missing).
 * Not exported: TypeORM takes every exported function of a migration file for a migration class.
 */
async function setDeleteRule(
  queryRunner: QueryRunner,
  table: string,
  column: string,
  ref: string,
  rule: Rule,
): Promise<void> {
  const found: { name: string; rule: string }[] = await queryRunner.query(
    `SELECT c.conname AS name, c.confdeltype AS rule
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.conrelid = format('%I', $1::text)::regclass
        AND c.confrelid = format('%I', $3::text)::regclass
        AND array_length(c.conkey, 1) = 1 AND a.attname = $2`,
    [table, column, ref],
  );
  const code = { RESTRICT: 'r', 'SET NULL': 'n', CASCADE: 'c', 'NO ACTION': 'a' }[rule];
  if (found.length === 1 && found[0].rule === code) return;
  const name = found[0]?.name ?? `FK_${table}_${column}`;
  for (const fk of found) await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${fk.name}"`);
  await queryRunner.query(
    `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES "${ref}"("id") ON DELETE ${rule} ON UPDATE NO ACTION`,
  );
}
