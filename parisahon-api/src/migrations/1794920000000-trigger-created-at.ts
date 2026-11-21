import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When a trigger was created: deals that entered the stage before that moment
 * do not get its delayed runs (src/trigger/trigger.service.ts, planMissingDelayedRuns).
 */
export class TriggerCreatedAt1794920000000 implements MigrationInterface {
  name = 'TriggerCreatedAt1794920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "trigger" ADD "created_at" TIMESTAMP NOT NULL DEFAULT now()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trigger" DROP COLUMN "created_at"`);
  }
}
