import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * «Старый клиент» (company.is_old) back for the companies the deal form reset.
 *
 * Saving a deal used to PATCH its company with is_old: false hard-coded, so a repeat client
 * became "new" (the companies filter and the "new clients" count of the managers' statistics
 * were wrong) and the company's deals got the history entry «is_old: true → false». The form
 * no longer sends the flag it does not show. Here a company whose LAST change of the flag in
 * the history is true → false and which is "new" now gets the flag back.
 *
 * The history keeps no trace of which screen made the change: a flag unticked on purpose in
 * the company card (rare: a repeat client does not become new again) comes back too. Changes
 * of a company without deals have no history entry and cannot be found.
 */
export class CompanyIsOldRestore1795220000200 implements MigrationInterface {
  name = 'CompanyIsOldRestore1795220000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [, restored] = await queryRunner.query(
      `WITH last_change AS (
          SELECT DISTINCT ON (d.company_id) d.company_id,
                 e.after_state -> 'data' ->> 'old_value' AS old_value,
                 e.after_state -> 'data' ->> 'new_value' AS new_value
            FROM event e
            JOIN deal d ON d.id = e.deal_id
           WHERE e.field_of = 'company'
             AND e.type IN (3, 4)
             AND e.after_state -> 'data' ->> 'field' = 'is_old'
             AND d.company_id IS NOT NULL
           ORDER BY d.company_id, e.created_at DESC, e.id DESC
       )
       UPDATE company c SET is_old = true
         FROM last_change l
        WHERE l.company_id = c.id
          AND l.old_value = 'true' AND l.new_value = 'false'
          AND c.is_old = false`,
    );

    console.log(`${this.name}: «Старый клиент» restored for ${restored ?? 0} compan(y/ies)`);
  }

  // which companies had it reset is in the history; the restore itself is not undone
  public async down(): Promise<void> {
    return;
  }
}
