import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The history of deals and clients (review wave 1, group "feed"): the rows written before the
 * listener was fixed (src/events/listeners/event.listener.ts). Data only, no schema change.
 *
 *  - MAIL-2: a letter's direction in the `outgoing` column (it kept the default "outgoing" for the
 *    letters of clients too, so the control of answers, «клиент ждёт ответа» and the autopilot
 *    took a client's letter for an answer). The letters that become incoming here and are younger
 *    than three days are marked as already reminded of: the fix is not a burst of reminders.
 *  - DEAL-12 / CALL-7: a call is dated by the call (the recording), not by the moment the phone
 *    synced it or «Создать сделку» linked it; an outgoing call is from the manager to the client.
 *  - the closing of a task points to the task (a task of a company or a contact is in their feed);
 *  - AUDIT-9: the responsible of a deal changed by a trigger ("agent_id") gets the names next to the ids;
 *  - AUDIT-15: the rights, goals and messenger ids of employees out of the snapshots of new deals
 *    and tasks, and of the people of letters (every reader of the deal's history got them).
 */
export class FeedHistory1795210000000 implements MigrationInterface {
  name = 'FeedHistory1795210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // MAIL-2
    await queryRunner.query(`
      WITH fixed AS (
        UPDATE "event"
           SET outgoing = (("after_state" -> 'data') ->> 'outgoing') = 'true'
         WHERE type = 9
           AND (("after_state" -> 'data') ->> 'outgoing') IN ('true', 'false')
           AND outgoing IS DISTINCT FROM ((("after_state" -> 'data') ->> 'outgoing') = 'true')
        RETURNING id, outgoing, created_at
      )
      INSERT INTO "control_notice" ("event_id", "level")
      SELECT f.id, l.level
        FROM fixed f CROSS JOIN (VALUES (1), (2)) AS l(level)
       WHERE NOT f.outgoing AND f.created_at > now() - interval '3 days'
      ON CONFLICT DO NOTHING
    `);

    // DEAL-12 / CALL-7: the time of the call
    await queryRunner.query(`
      UPDATE "event" e
         SET created_at = r.created_at
        FROM "recording" r
       WHERE e.type = 10
         AND r.path IS NOT NULL
         AND (e."after_state" ->> 'path') = r.path
         AND e.created_at IS DISTINCT FROM r.created_at
    `);
    // ... and who called whom: the services passed the client as the author of every call
    await queryRunner.query(`
      UPDATE "event" e
         SET user_id = e.target_user_id, target_user_id = e.user_id
        FROM "user" c, "user" m
       WHERE e.type = 10
         AND e.outgoing = true
         AND c.id = e.user_id AND c.role = 'ctr_agent'
         AND m.id = e.target_user_id AND m.role <> 'ctr_agent'
    `);

    // the closing of a task points to the task
    await queryRunner.query(`
      UPDATE "event" e
         SET task_id = t.id
        FROM "task" t
       WHERE e.type = 7
         AND e.task_id IS NULL
         AND (("e"."after_state" -> 'data') ->> 'id') ~ '^[0-9]{1,9}$'
         AND t.id = (("e"."after_state" -> 'data') ->> 'id')::int
    `);

    // AUDIT-9: names of the responsible changed by a trigger
    for (const [value, label] of [
      ['new_value', 'new_label'],
      ['old_value', 'old_label'],
    ]) {
      await queryRunner.query(`
        UPDATE "event" e
           SET after_state = jsonb_set(e."after_state", '{data,${label}}', to_jsonb(COALESCE(u.username, '')))
          FROM "user" u
         WHERE e.type IN (3, 4)
           AND jsonb_typeof(e."after_state" -> 'data') = 'object'
           AND ((e."after_state" -> 'data') ->> 'field') = 'agent_id'
           AND ((e."after_state" -> 'data') -> '${label}') IS NULL
           AND ((e."after_state" -> 'data') ->> '${value}') ~ '^[0-9]{1,9}$'
           AND u.id = ((e."after_state" -> 'data') ->> '${value}')::int
      `);
    }

    // AUDIT-15: an employee in a snapshot is who it was, not their account
    for (const person of ['agent', 'created_by']) {
      await queryRunner.query(`
        UPDATE "event"
           SET after_state = "after_state"
             #- '{data,${person},permissions}'
             #- '{data,${person},objectives}'
             #- '{data,${person},tg_id}'
             #- '{data,${person},wa_id}'
         WHERE type IN (0, 6, 7)
           AND jsonb_typeof("after_state" -> 'data') = 'object'
           AND jsonb_typeof(("after_state" -> 'data') -> '${person}') = 'object'
           AND ((("after_state" -> 'data') -> '${person}') -> 'permissions' IS NOT NULL
             OR (("after_state" -> 'data') -> '${person}') -> 'objectives' IS NOT NULL
             OR (("after_state" -> 'data') -> '${person}') -> 'tg_id' IS NOT NULL
             OR (("after_state" -> 'data') -> '${person}') -> 'wa_id' IS NOT NULL)
      `);
    }
    // ... and the people of a letter (who sent it from the CRM, the contact it is from)
    for (const person of ['sent_by', 'from_user', 'deleted_by']) {
      await queryRunner.query(`
        UPDATE "event"
           SET after_state = "after_state"
             #- '{data,${person},permissions}'
             #- '{data,${person},objectives}'
             #- '{data,${person},tg_id}'
             #- '{data,${person},wa_id}'
             #- '{data,${person},linked_deals}'
         WHERE type = 9
           AND jsonb_typeof("after_state" -> 'data') = 'object'
           AND jsonb_typeof(("after_state" -> 'data') -> '${person}') = 'object'
           AND ((("after_state" -> 'data') -> '${person}') -> 'permissions' IS NOT NULL
             OR (("after_state" -> 'data') -> '${person}') -> 'objectives' IS NOT NULL
             OR (("after_state" -> 'data') -> '${person}') -> 'tg_id' IS NOT NULL
             OR (("after_state" -> 'data') -> '${person}') -> 'wa_id' IS NOT NULL
             OR (("after_state" -> 'data') -> '${person}') -> 'linked_deals' IS NOT NULL)
      `);
    }
  }

  public async down(): Promise<void> {
    // data corrections: the values before them were wrong, nothing to restore
  }
}
