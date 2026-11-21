import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schedule of the deal-stage triggers (src/trigger/trigger-run.entity.ts):
 * planned and finished executions per trigger and deal, so that delayed and
 * recurring triggers survive a restart of the API.
 */
export class TriggerRuns1794900000000 implements MigrationInterface {
  name = 'TriggerRuns1794900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "trigger_run" (
        "id" SERIAL NOT NULL,
        "trigger_id" integer NOT NULL,
        "deal_id" integer NOT NULL,
        "run_at" TIMESTAMP NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "executed_at" TIMESTAMP,
        "error" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_trigger_run" PRIMARY KEY ("id"),
        CONSTRAINT "FK_trigger_run_trigger" FOREIGN KEY ("trigger_id") REFERENCES "trigger"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_trigger_run_deal" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_trigger_run_due" ON "trigger_run" ("status", "run_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_trigger_run_trigger_deal" ON "trigger_run" ("trigger_id", "deal_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "trigger_run"`);
  }
}
