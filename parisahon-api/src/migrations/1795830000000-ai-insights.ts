import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * More AI on top of the AI core (src/ai-insights): the AI's reading of the first message of a new contact
 * (deal_inbound, one row per deal), the nightly review of the managers' dialogs (conversation_review, one row
 * per deal and day), what the digests and the weekly tips sent to whom (ai_notice, once per kind, employee
 * and day) and what clients say about the market (market_mention, rows of a turn of the AI core).
 * New tables only: nothing existing changes, so it runs on the production data as is. The rows are derived
 * data: they go with their deal, turn or employee (ON DELETE CASCADE); a deleted AI job or reviewer only
 * empties the link. Times are timestamptz, like every table after migration 1795729000000.
 */
export class AiInsights1795830000000 implements MigrationInterface {
  name = 'AiInsights1795830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "deal_inbound" (
        "id" SERIAL NOT NULL,
        "deal_id" integer NOT NULL,
        "job_id" integer,
        "event_id" integer,
        "channel" character varying(16) NOT NULL,
        "has_email" boolean NOT NULL DEFAULT false,
        "ai_category" character varying(16) NOT NULL,
        "category" character varying(16) NOT NULL,
        "country" character varying(64),
        "client_type" character varying(16),
        "language" character varying(16),
        "wants" text,
        "quote" text,
        "quote_event_id" integer,
        "reason" text,
        "status" character varying(16) NOT NULL DEFAULT 'new',
        "reviewed_by" integer,
        "reviewed_at" TIMESTAMPTZ,
        "notified_at" TIMESTAMPTZ,
        "note_event_id" integer,
        "prompt_version" character varying(32) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_deal_inbound" PRIMARY KEY ("id"),
        CONSTRAINT "FK_deal_inbound_deal" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_deal_inbound_job" FOREIGN KEY ("job_id") REFERENCES "ai_job"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_deal_inbound_reviewed_by" FOREIGN KEY ("reviewed_by") REFERENCES "user"("id") ON DELETE SET NULL
      )
    `);
    // one reading per deal
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_deal_inbound_deal" ON "deal_inbound" ("deal_id")`);
    // the owner's list «Новые обращения»: by category, newest first
    await queryRunner.query(`CREATE INDEX "IDX_deal_inbound_category_created" ON "deal_inbound" ("category", "created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_deal_inbound_job" ON "deal_inbound" ("job_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_deal_inbound_reviewed_by" ON "deal_inbound" ("reviewed_by")`);

    await queryRunner.query(`
      CREATE TABLE "conversation_review" (
        "id" SERIAL NOT NULL,
        "deal_id" integer NOT NULL,
        "day" date NOT NULL,
        "agent_id" integer,
        "job_id" integer,
        "from_event_id" integer NOT NULL,
        "to_event_id" integer NOT NULL,
        "channels" character varying(64) NOT NULL DEFAULT '',
        "has_email" boolean NOT NULL DEFAULT false,
        "messages" smallint NOT NULL DEFAULT 0,
        "scores" jsonb,
        "score" smallint,
        "mistakes" jsonb,
        "summary" text,
        "prompt_version" character varying(32) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_review" PRIMARY KEY ("id"),
        CONSTRAINT "FK_conversation_review_deal" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversation_review_agent" FOREIGN KEY ("agent_id") REFERENCES "user"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_conversation_review_job" FOREIGN KEY ("job_id") REFERENCES "ai_job"("id") ON DELETE SET NULL
      )
    `);
    // a dialog (a deal's messages of one day) is reviewed once
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_conversation_review_deal_day" ON "conversation_review" ("deal_id", "day")`);
    // «Качество диалогов» per employee and period, the weekly tips
    await queryRunner.query(`CREATE INDEX "IDX_conversation_review_agent_day" ON "conversation_review" ("agent_id", "day")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversation_review_day" ON "conversation_review" ("day")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversation_review_job" ON "conversation_review" ("job_id")`);

    await queryRunner.query(`
      CREATE TABLE "ai_notice" (
        "id" SERIAL NOT NULL,
        "kind" character varying(16) NOT NULL,
        "user_id" integer NOT NULL,
        "day" date NOT NULL,
        "delivered" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_notice" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_notice_user" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
      )
    `);
    // once per kind, employee and day (claimed before sending: two API processes never send twice)
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ai_notice_kind_user_day" ON "ai_notice" ("kind", "user_id", "day")`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_notice_user" ON "ai_notice" ("user_id")`);

    await queryRunner.query(`
      CREATE TABLE "market_mention" (
        "id" SERIAL NOT NULL,
        "deal_id" integer NOT NULL,
        "turn_id" integer NOT NULL,
        "job_id" integer,
        "event_id" integer,
        "kind" character varying(16) NOT NULL,
        "supplier" character varying(120),
        "country" character varying(64),
        "product" character varying(120),
        "size" character varying(64),
        "grammage" character varying(32),
        "price" numeric(14,2),
        "currency" character varying(8),
        "unit" character varying(16),
        "price_text" character varying(64),
        "moq" character varying(64),
        "delivery" character varying(64),
        "quality" character varying(200),
        "payment" character varying(120),
        "quote" text,
        "has_email" boolean NOT NULL DEFAULT false,
        "mentioned_at" TIMESTAMPTZ NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_market_mention" PRIMARY KEY ("id"),
        CONSTRAINT "FK_market_mention_deal" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_market_mention_turn" FOREIGN KEY ("turn_id") REFERENCES "conversation_turn"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_market_mention_job" FOREIGN KEY ("job_id") REFERENCES "ai_job"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_market_mention_deal" ON "market_mention" ("deal_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_market_mention_turn" ON "market_mention" ("turn_id")`);
    // «Рынок» for a period
    await queryRunner.query(`CREATE INDEX "IDX_market_mention_at" ON "market_mention" ("mentioned_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_market_mention_job" ON "market_mention" ("job_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "market_mention"`);
    await queryRunner.query(`DROP TABLE "ai_notice"`);
    await queryRunner.query(`DROP TABLE "conversation_review"`);
    await queryRunner.query(`DROP TABLE "deal_inbound"`);
  }
}
