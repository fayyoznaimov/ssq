import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every task has a type (review wave 1b, HACK-13). The web client and the history read the type of a
 * task; a deleted type used to leave its tasks without one (ON DELETE SET NULL) and the board and the
 * deal history broke. Deleting a type now moves its tasks to another type first (TaskTypeService), so
 * the database may refuse a type that still has tasks (ON DELETE RESTRICT) and a task without a type.
 *
 * Data: a task still without a type gets DEFAULT_TASK_TYPE ("Связаться"), else the first type (a type
 * is created when there is none at all and a task needs one).
 */
export class TaskTypeRequired1795650000000 implements MigrationInterface {
  name = 'TaskTypeRequired1795650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const name = (process.env.DEFAULT_TASK_TYPE || 'Связаться').trim();
    await queryRunner.query(
      `INSERT INTO "task_type" (name)
       SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM "task_type") AND EXISTS (SELECT 1 FROM "task" WHERE type_id IS NULL)`,
      [name],
    );
    await queryRunner.query(
      `UPDATE "task" SET type_id = COALESCE(
         (SELECT id FROM "task_type" WHERE name = $1 ORDER BY id LIMIT 1),
         (SELECT id FROM "task_type" ORDER BY id LIMIT 1))
       WHERE type_id IS NULL`,
      [name],
    );
    await queryRunner.query(`ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "FK_a0669bd34078f33604ec209dab1"`);
    await queryRunner.query(`ALTER TABLE "task" ALTER COLUMN "type_id" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "task" ADD CONSTRAINT "FK_a0669bd34078f33604ec209dab1" FOREIGN KEY ("type_id") REFERENCES "task_type"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "FK_a0669bd34078f33604ec209dab1"`);
    await queryRunner.query(`ALTER TABLE "task" ALTER COLUMN "type_id" DROP NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "task" ADD CONSTRAINT "FK_a0669bd34078f33604ec209dab1" FOREIGN KEY ("type_id") REFERENCES "task_type"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }
}
