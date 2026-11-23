import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tasks (review wave 1, group "tasks"). Data only, no schema change.
 *
 *  - TASK-2: automatic and trigger tasks are linked to a deal and to its company. Moving one on the
 *    board or in the calendar, or saving it in the task window, sent the company first and the API
 *    dropped the deal: the task left the deal page, its "done" went to no deal's history and the
 *    autopilot put a second task on the deal. Such a task comes back to the deal of its NEW_TASK event
 *    when it is still linked to that deal's company, and its "done" event goes back to the deal too.
 *  - TASK-1: a task without a type (the autopilot before it got DEFAULT_TASK_TYPE, a deleted type)
 *    gets the default type, and the history of typeless tasks a neutral type: older clients that are
 *    still open in a browser read type.name and lose the whole deal history on a null.
 */
export class TaskLinks1795250000000 implements MigrationInterface {
  name = 'TaskLinks1795250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // TASK-2: back to the deal (only when the task kept that deal's company)
    await queryRunner.query(`
      WITH source AS (
        SELECT DISTINCT ON (t.id) t.id AS task_id, e.deal_id
          FROM "task" t
          JOIN "event" e ON e.task_id = t.id AND e.type = 6 AND e.deal_id IS NOT NULL
          JOIN "deal" d ON d.id = e.deal_id
         WHERE t.deal_id IS NULL
           AND t.company_id IS NOT NULL
           AND d.company_id = t.company_id
         ORDER BY t.id, e.id
      ), relinked AS (
        UPDATE "task" t
           SET deal_id = s.deal_id
          FROM source s
         WHERE t.id = s.task_id
        RETURNING t.id, t.deal_id
      )
      UPDATE "event" ev
         SET deal_id = r.deal_id
        FROM relinked r
       WHERE ev.type IN (7, 17)
         AND ev.deal_id IS NULL
         AND (ev.task_id = r.id
              OR (jsonb_typeof(ev."after_state" -> 'data') = 'object'
                  AND ((ev."after_state" -> 'data') ->> 'id') = r.id::text))
    `);

    // TASK-1: the default type for typeless tasks (as default-task-type.ts picks it)
    const name = (process.env.DEFAULT_TASK_TYPE || 'Связаться').trim();
    await queryRunner.query(
      `UPDATE "task"
          SET type_id = COALESCE(
            (SELECT id FROM "task_type" WHERE name = $1 ORDER BY id LIMIT 1),
            (SELECT id FROM "task_type" ORDER BY id LIMIT 1))
        WHERE type_id IS NULL
          AND EXISTS (SELECT 1 FROM "task_type")`,
      [name],
    );

    // ... and a neutral type in the history of tasks that had none
    for (const state of ['after_state', 'before_state']) {
      await queryRunner.query(`
        UPDATE "event"
           SET "${state}" = jsonb_set("${state}", '{data,type}', '{"id": null, "name": "Задача"}'::jsonb)
         WHERE type IN (6, 7, 17)
           AND jsonb_typeof("${state}" -> 'data') = 'object'
           AND (NOT (("${state}" -> 'data') ? 'type') OR jsonb_typeof(("${state}" -> 'data') -> 'type') <> 'object')
      `);
    }
  }

  public async down(): Promise<void> {
    // data corrections: the values before them were wrong, nothing to restore
  }
}
