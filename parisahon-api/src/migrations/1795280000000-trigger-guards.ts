import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Triggers that cannot run twice or flood a client (src/trigger/trigger.service.ts):
 *  - trigger_run.note: what a done run did («создана задача …», «удалено файлов: …»);
 *  - at most one pending run per trigger and deal: a unique partial index (planning from a request
 *    and from the scheduler at the same moment used to make two runs). Pending duplicates that are
 *    already there are skipped first, the earliest one stays;
 *  - the deadlines of "create task" match their labels: «Через день» was 2 days (2880 min),
 *    «Через 3 дня» 4 days (5760), «Конец дня» the same time tomorrow (1440 + all day). They become
 *    1440, 4320 and the end of the working day (deadline end_of_working_day);
 *  - a custom field in the conditions of a trigger and in "change fields" is kept by its id too
 *    (filler_id), so that renaming the field does not break the trigger: the id is filled in for
 *    the triggers saved before, by the field's current name.
 */
export class TriggerGuards1795280000000 implements MigrationInterface {
  name = 'TriggerGuards1795280000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trigger_run" ADD COLUMN IF NOT EXISTS "note" text`);

    await queryRunner.query(`
      UPDATE "trigger_run" r
         SET "status" = 'skipped', "executed_at" = now(), "error" = 'дубль запланированного запуска'
       WHERE r."status" = 'pending'
         AND EXISTS (SELECT 1 FROM "trigger_run" x
                      WHERE x."trigger_id" = r."trigger_id" AND x."deal_id" = r."deal_id" AND x."status" = 'pending'
                        AND (x."run_at", x."id") < (r."run_at", r."id"))
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_trigger_run_pending" ON "trigger_run" ("trigger_id", "deal_id") WHERE "status" = 'pending'`,
    );

    // «Конец дня» first: it was 1440 minutes too
    await queryRunner.query(`
      UPDATE "trigger"
         SET "data" = "data" || '{"deadline": "end_of_working_day", "end_time_in_minutes": 0, "all_day": false}'::jsonb
       WHERE "type" = 0 AND jsonb_typeof("data") = 'object'
         AND "data"->>'end_time_in_minutes' = '1440' AND "data"->>'all_day' = 'true'
    `);
    await queryRunner.query(`
      UPDATE "trigger" SET "data" = jsonb_set("data", '{end_time_in_minutes}', '1440'::jsonb)
       WHERE "type" = 0 AND jsonb_typeof("data") = 'object' AND "data"->>'end_time_in_minutes' = '2880'
    `);
    await queryRunner.query(`
      UPDATE "trigger" SET "data" = jsonb_set("data", '{end_time_in_minutes}', '4320'::jsonb)
       WHERE "type" = 0 AND jsonb_typeof("data") = 'object' AND "data"->>'end_time_in_minutes' = '5760'
    `);

    // custom fields by id: the conditions of every trigger, the fields of "change fields" (type 5).
    // Whatever odd shape a stored value has (null, an object), it is read as an empty list, never an error.
    const list = (value: string) => `(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END)`;
    const withIds = (value: string) => `COALESCE((
      SELECT jsonb_agg(CASE WHEN f.value->>'is_filler' = 'true' AND f.value->'filler_id' IS NULL AND fl.id IS NOT NULL
                            THEN f.value || jsonb_build_object('filler_id', fl.id)
                            ELSE f.value END ORDER BY f.n)
        FROM jsonb_array_elements(${list(value)}) WITH ORDINALITY AS f(value, n)
        LEFT JOIN LATERAL (SELECT x."id" FROM "filler" x
                            WHERE x."target" = 'deal' AND x."field" = f.value->>'field' ORDER BY x."id" LIMIT 1) fl ON TRUE
    ), ${value})`;
    const lacksIds = (value: string) =>
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${list(value)}) e WHERE e->>'is_filler' = 'true' AND e->'filler_id' IS NULL)`;
    await queryRunner.query(`
      UPDATE "trigger" t SET "deal_filters" = ${withIds('t."deal_filters"')}
       WHERE jsonb_typeof(t."deal_filters") = 'array' AND ${lacksIds('t."deal_filters"')}
    `);
    await queryRunner.query(`
      UPDATE "trigger" t SET "data" = jsonb_set(t."data", '{fields}', ${withIds(`t."data"->'fields'`)})
       WHERE t."type" = 5 AND jsonb_typeof(t."data") = 'object' AND jsonb_typeof(t."data"->'fields') = 'array'
         AND ${lacksIds(`t."data"->'fields'`)}
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trigger_run_pending"`);
    await queryRunner.query(`ALTER TABLE "trigger_run" DROP COLUMN IF EXISTS "note"`);
  }
}
