import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The AI core (src/ai): the queue of AI requests (ai_job), the CLI calls per day and the pause after
 * the usage limit (ai_usage), the analyses of conversation turns of deals (conversation_turn) and the
 * questions and promises they found (conversation_item). New tables only: nothing existing changes,
 * so it runs on the production data as is. The AI tables are derived data: they go with their deal
 * (ON DELETE CASCADE); a deleted task or user only empties the link.
 */
export class AiCore1795820000000 implements MigrationInterface {
  name = 'AiCore1795820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_job" (
        "id" SERIAL NOT NULL,
        "kind" character varying(32) NOT NULL,
        "entity" character varying(32) NOT NULL,
        "entity_id" integer NOT NULL,
        "input_hash" character varying(64) NOT NULL,
        "input" jsonb,
        "priority" smallint NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'queued',
        "attempts" smallint NOT NULL DEFAULT 0,
        "run_after" TIMESTAMP NOT NULL DEFAULT now(),
        "result" jsonb,
        "error" text,
        "prompt_version" character varying(32) NOT NULL,
        "model" character varying(64),
        "requested_by" integer,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "started_at" TIMESTAMP,
        "finished_at" TIMESTAMP,
        "duration_ms" integer,
        CONSTRAINT "PK_ai_job" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_job_requested_by" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE SET NULL
      )
    `);
    // the same input never twice: a second request with it finds the first job
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ai_job_input" ON "ai_job" ("kind", "input_hash")`);
    // the worker's pick: the smallest priority, the oldest first, among the queued ones
    await queryRunner.query(`CREATE INDEX "IDX_ai_job_queue" ON "ai_job" ("priority", "run_after", "id") WHERE "status" = 'queued'`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_job_entity" ON "ai_job" ("entity", "entity_id", "kind")`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_job_requested_by" ON "ai_job" ("requested_by")`);

    await queryRunner.query(`
      CREATE TABLE "ai_usage" (
        "day" date NOT NULL,
        "background_calls" integer NOT NULL DEFAULT 0,
        "interactive_calls" integer NOT NULL DEFAULT 0,
        "limit_hits" integer NOT NULL DEFAULT 0,
        "paused_until" TIMESTAMP,
        "pause_reason" character varying(255),
        CONSTRAINT "PK_ai_usage" PRIMARY KEY ("day")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "conversation_turn" (
        "id" SERIAL NOT NULL,
        "deal_id" integer NOT NULL,
        "job_id" integer,
        "from_event_id" integer NOT NULL,
        "to_event_id" integer NOT NULL,
        "client_at" TIMESTAMP,
        "answered_at" TIMESTAMP,
        "channels" character varying(64) NOT NULL DEFAULT '',
        "has_email" boolean NOT NULL DEFAULT false,
        "unanswered_questions" jsonb,
        "promises" jsonb,
        "order_params" jsonb,
        "flags" jsonb,
        "language" character varying(16),
        "summary" text,
        "prompt_version" character varying(32) NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_turn" PRIMARY KEY ("id"),
        CONSTRAINT "FK_conversation_turn_deal" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversation_turn_job" FOREIGN KEY ("job_id") REFERENCES "ai_job"("id") ON DELETE SET NULL
      )
    `);
    // a turn of a deal is analysed once; the next one starts after the largest to_event_id
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_conversation_turn_deal_end" ON "conversation_turn" ("deal_id", "to_event_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversation_turn_job" ON "conversation_turn" ("job_id")`);

    await queryRunner.query(`
      CREATE TABLE "conversation_item" (
        "id" SERIAL NOT NULL,
        "deal_id" integer NOT NULL,
        "turn_id" integer NOT NULL,
        "kind" character varying(16) NOT NULL,
        "who" character varying(16),
        "text" character varying(500) NOT NULL,
        "event_id" integer,
        "has_email" boolean NOT NULL DEFAULT false,
        "due_at" TIMESTAMP,
        "due_has_time" boolean NOT NULL DEFAULT false,
        "status" character varying(16) NOT NULL DEFAULT 'open',
        "close_reason" character varying(32),
        "closed_at" TIMESTAMP,
        "closed_by" integer,
        "task_id" integer,
        "tasked_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_item" PRIMARY KEY ("id"),
        CONSTRAINT "FK_conversation_item_deal" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversation_item_turn" FOREIGN KEY ("turn_id") REFERENCES "conversation_turn"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversation_item_closed_by" FOREIGN KEY ("closed_by") REFERENCES "user"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_conversation_item_task" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_conversation_item_deal_status" ON "conversation_item" ("deal_id", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversation_item_turn" ON "conversation_item" ("turn_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversation_item_task" ON "conversation_item" ("task_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversation_item_closed_by" ON "conversation_item" ("closed_by")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "conversation_item"`);
    await queryRunner.query(`DROP TABLE "conversation_turn"`);
    await queryRunner.query(`DROP TABLE "ai_usage"`);
    await queryRunner.query(`DROP TABLE "ai_job"`);
  }
}
