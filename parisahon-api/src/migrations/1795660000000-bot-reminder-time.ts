import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The bot remembers WHICH start time of a task it reminded about (bot_reminder.start_time): a task
 * moved to another time by any path (the web, the bot, a trigger, SQL) is reminded again before its
 * new start. The reminders already sent were for the tasks' current start times (TaskService.update
 * deleted the mark on a move), so the column is filled from the task.
 */
export class BotReminderTime1795660000000 implements MigrationInterface {
  name = 'BotReminderTime1795660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bot_reminder" ADD COLUMN IF NOT EXISTS "start_time" TIMESTAMP`);
    await queryRunner.query(`UPDATE "bot_reminder" r SET "start_time" = t."start_time" FROM "task" t WHERE t."id" = r."task_id" AND r."start_time" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bot_reminder" DROP COLUMN IF EXISTS "start_time"`);
  }
}
