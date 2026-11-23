import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * deal.closed_at follows the stage: a deal in a closing stage («успешно реализовано»,
 * «закрыто и не реализовано») is closed, in any other stage it is open. Until now closed_at was
 * set on closing and never cleared, so a deal taken back to work stayed "closed" for the routing
 * of messages, calls and letters, for the triggers, the autopilot, «клиент ждёт» and the reports
 * (they all read closed_at IS NULL as open); a deal created right in a closing stage never got
 * the date. DealService.moveDealToStage / create keep it that way from now on.
 *
 * The closing stages are known by their names, as DealStageService reads them
 * (DEAL_STAGE_CLOSED, DEAL_STAGE_CLOSED_NOT_REALIZED). When no stage of the database has these
 * names nothing is changed: a wrong name must not open every closed deal.
 */
export class DealClosedAt1795220000000 implements MigrationInterface {
  name = 'DealClosedAt1795220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const names = [process.env.DEAL_STAGE_CLOSED, process.env.DEAL_STAGE_CLOSED_NOT_REALIZED].filter(Boolean);
    const known: { n: number }[] = names.length
      ? await queryRunner.query(`SELECT count(*)::int AS n FROM deal_stage WHERE name = ANY($1::text[])`, [names])
      : [];
    if (!known.length || Number(known[0].n) === 0) {
      console.warn(`${this.name}: no stage named ${JSON.stringify(names)}, deal.closed_at is left as it is`);
      return;
    }

    // taken back to work, still marked closed
    const [, reopened] = await queryRunner.query(
      `UPDATE deal d SET closed_at = NULL
         FROM deal_stage s
        WHERE s.id = d.stage_id AND d.closed_at IS NOT NULL AND NOT (s.name = ANY($1::text[]))`,
      [names],
    );

    // in a closing stage without the date: closed when it got there
    const [, closed] = await queryRunner.query(
      `UPDATE deal d SET closed_at = COALESCE(d.last_stage_change, d.created_at)
         FROM deal_stage s
        WHERE s.id = d.stage_id AND d.closed_at IS NULL AND s.name = ANY($1::text[])`,
      [names],
    );

    console.log(`${this.name}: ${reopened ?? 0} deal(s) open again, ${closed ?? 0} deal(s) in a closing stage got closed_at`);
  }

  // the wrong dates are not kept anywhere: nothing to bring back
  public async down(): Promise<void> {
    return;
  }
}
