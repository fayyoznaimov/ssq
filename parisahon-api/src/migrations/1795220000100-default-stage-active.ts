import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * «Этап для новых сделок» (setting.default_stage_id) belongs to the active collection.
 * It used to stay on a stage of the previous collection after another one was activated,
 * so the deals from Telegram, WhatsApp, calls and mail were created in the old pipeline and
 * were not on the board. Such a setting (and one that points to a closing stage) moves to
 * the stage of the same name of the active collection, otherwise to its "unknown" stage —
 * what DealStageService.activateCollection does from now on. Nothing changes when there is
 * no active collection.
 */
export class DefaultStageActive1795220000100 implements MigrationInterface {
  name = 'DefaultStageActive1795220000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const closing = [process.env.DEAL_STAGE_CLOSED, process.env.DEAL_STAGE_CLOSED_NOT_REALIZED].filter(Boolean);
    const unknown = process.env.DEAL_STAGE_UNKNOWN || null;

    const [, moved] = await queryRunner.query(
      `UPDATE setting st SET default_stage_id = COALESCE(
          (SELECT s2.id FROM deal_stage s2 JOIN collection c2 ON c2.id = s2.collection_id AND c2.is_active
            WHERE s2.name = s.name AND NOT (s2.name = ANY($1::text[])) ORDER BY s2.id LIMIT 1),
          (SELECT s3.id FROM deal_stage s3 JOIN collection c3 ON c3.id = s3.collection_id AND c3.is_active
            WHERE s3.name = $2 ORDER BY s3.id LIMIT 1),
          st.default_stage_id)
         FROM deal_stage s
         LEFT JOIN collection c ON c.id = s.collection_id
        WHERE s.id = st.default_stage_id
          AND (c.is_active IS NOT TRUE OR s.name = ANY($1::text[]))
          AND EXISTS (SELECT 1 FROM collection a WHERE a.is_active)`,
      [closing, unknown],
    );

    console.log(`${this.name}: ${moved ?? 0} setting row(s) moved to the active collection`);
  }

  // the stage of the old collection is not remembered: nothing to bring back
  public async down(): Promise<void> {
    return;
  }
}
