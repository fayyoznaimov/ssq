import { MigrationInterface, QueryRunner } from 'typeorm';

/** control_notice: which «клиент ждёт ответа» reminders were sent (one per client message and level). */
export class ControlNotice1795120000000 implements MigrationInterface {
  name = 'ControlNotice1795120000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "control_notice" (
      "event_id" integer NOT NULL REFERENCES "event"("id") ON DELETE CASCADE,
      "level" smallint NOT NULL,
      "sent_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("event_id", "level"))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "control_notice"`);
  }
}
