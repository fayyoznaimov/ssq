import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The meaning of a stage is deal_stage.kind, not its name (K10, DB-10 / HACK-12; deal_stage/stage-kind.ts):
 * new, first_contact, prepayment, won, lost — one of each per pipeline — and work for every other stage.
 * Until now the code compared stage names with DEAL_STAGE_* of .env: a renamed stage or a typo in .env
 * silently broke closing, goals, analytics and the desktop.
 *
 * The kinds are filled from the names .env uses now (DEAL_STAGE_*, otherwise the usual Russian names):
 * in every pipeline the first stage with such a name gets the kind. A partial unique index keeps one
 * stage of each system kind per pipeline.
 *
 * The stage history gets the stage the deal came from and who moved it (deal_stage_record.from_stage_id,
 * moved_by). Old rows: from_stage_id is the stage of the previous row of the deal; moved_by is the author
 * of the matching «Этап изменён» event of the deal history, and the creator of the deal for its first row.
 */
export class DealStageKind1795620000000 implements MigrationInterface {
  name = 'DealStageKind1795620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deal_stage" ADD COLUMN IF NOT EXISTS "kind" varchar(16) NOT NULL DEFAULT 'work'`);
    await queryRunner.query(`ALTER TABLE "deal_stage" DROP CONSTRAINT IF EXISTS "CHK_deal_stage_kind"`);
    await queryRunner.query(
      `ALTER TABLE "deal_stage" ADD CONSTRAINT "CHK_deal_stage_kind" CHECK ("kind" IN ('new', 'first_contact', 'prepayment', 'won', 'lost', 'work'))`,
    );

    const kinds: [string, string, string][] = [
      ['new', 'DEAL_STAGE_UNKNOWN', 'НЕРАЗОБРАННОЕ'],
      ['first_contact', 'DEAL_STAGE_CREATED', 'ПЕРВИЧНЫЙ КОНТАКТ'],
      ['prepayment', 'DEAL_STAGE_PREPAYMENT', 'ПРЕДОПЛАТА'],
      ['won', 'DEAL_STAGE_CLOSED', 'УСПЕШНО РЕАЛИЗОВАНО'],
      ['lost', 'DEAL_STAGE_CLOSED_NOT_REALIZED', 'ЗАКРЫТО И НЕ РЕАЛИЗОВАНО'],
    ];
    for (const [kind, env, fallback] of kinds) {
      const name = (process.env[env] || '').trim() || fallback;
      const [, changed] = await queryRunner.query(
        `UPDATE "deal_stage" s SET "kind" = $1
          WHERE s."kind" = 'work'
            AND s.id IN (SELECT MIN(x.id) FROM "deal_stage" x WHERE x.name = $2 GROUP BY x.collection_id)
            AND NOT EXISTS (SELECT 1 FROM "deal_stage" o WHERE o.collection_id = s.collection_id AND o."kind" = $1)`,
        [kind, name],
      );
      console.log(`${this.name}: «${name}» -> ${kind}: ${changed ?? 0} stage(s)`);
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_deal_stage_collection_kind" ON "deal_stage" ("collection_id", "kind") WHERE "kind" <> 'work'`,
    );

    // the stage history: from which stage, by whom
    await queryRunner.query(`ALTER TABLE "deal_stage_record" ADD COLUMN IF NOT EXISTS "from_stage_id" integer`);
    await queryRunner.query(`ALTER TABLE "deal_stage_record" ADD COLUMN IF NOT EXISTS "moved_by" integer`);
    await queryRunner.query(`ALTER TABLE "deal_stage_record" DROP CONSTRAINT IF EXISTS "FK_deal_stage_record_from_stage"`);
    await queryRunner.query(
      `ALTER TABLE "deal_stage_record" ADD CONSTRAINT "FK_deal_stage_record_from_stage" FOREIGN KEY ("from_stage_id") REFERENCES "deal_stage"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(`ALTER TABLE "deal_stage_record" DROP CONSTRAINT IF EXISTS "FK_deal_stage_record_moved_by"`);
    await queryRunner.query(
      `ALTER TABLE "deal_stage_record" ADD CONSTRAINT "FK_deal_stage_record_moved_by" FOREIGN KEY ("moved_by") REFERENCES "user"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_deal_stage_record_from_stage" ON "deal_stage_record" ("from_stage_id")`,
    );

    const [, fromFilled] = await queryRunner.query(
      `UPDATE "deal_stage_record" r SET "from_stage_id" = p.prev
         FROM (SELECT id, LAG(stage_id) OVER (PARTITION BY deal_id ORDER BY created_at, id) AS prev
                 FROM "deal_stage_record") p
        WHERE p.id = r.id AND p.prev IS NOT NULL AND r."from_stage_id" IS NULL`,
    );
    // a move: the author of the «Этап изменён» event (type 15) of the deal written right after the row
    const [, movedFilled] = await queryRunner.query(
      `UPDATE "deal_stage_record" r SET "moved_by" = (
          SELECT e.user_id FROM "event" e
           WHERE e.deal_id = r.deal_id AND e.type = 15 AND e.user_id IS NOT NULL
             AND e.after_state -> 'data' -> 'stage' ->> 'id' = r.stage_id::text
             AND e.created_at BETWEEN r.created_at - interval '5 seconds' AND r.created_at + interval '1 minute'
             AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = e.user_id)
           ORDER BY abs(extract(epoch FROM e.created_at - r.created_at)), e.id
           LIMIT 1)
        WHERE r."moved_by" IS NULL AND r."from_stage_id" IS NOT NULL`,
    );
    // the first stage of a deal: who created it
    const [, firstFilled] = await queryRunner.query(
      `UPDATE "deal_stage_record" r SET "moved_by" = d.created_by
         FROM "deal" d
        WHERE d.id = r.deal_id AND r."moved_by" IS NULL AND d.created_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "deal_stage_record" o
                           WHERE o.deal_id = r.deal_id AND (o.created_at, o.id) < (r.created_at, r.id))`,
    );
    console.log(
      `${this.name}: stage history: ${fromFilled ?? 0} row(s) got from_stage_id, ` +
        `${(movedFilled ?? 0)} move(s) and ${firstFilled ?? 0} first row(s) got moved_by`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deal_stage_record_from_stage"`);
    await queryRunner.query(`ALTER TABLE "deal_stage_record" DROP CONSTRAINT IF EXISTS "FK_deal_stage_record_moved_by"`);
    await queryRunner.query(`ALTER TABLE "deal_stage_record" DROP CONSTRAINT IF EXISTS "FK_deal_stage_record_from_stage"`);
    await queryRunner.query(`ALTER TABLE "deal_stage_record" DROP COLUMN IF EXISTS "moved_by"`);
    await queryRunner.query(`ALTER TABLE "deal_stage_record" DROP COLUMN IF EXISTS "from_stage_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deal_stage_collection_kind"`);
    await queryRunner.query(`ALTER TABLE "deal_stage" DROP CONSTRAINT IF EXISTS "CHK_deal_stage_kind"`);
    await queryRunner.query(`ALTER TABLE "deal_stage" DROP COLUMN IF EXISTS "kind"`);
  }
}
