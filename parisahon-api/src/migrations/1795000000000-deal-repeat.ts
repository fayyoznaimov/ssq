import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A deal opened for a client who already had deals ("повторное обращение"):
 * deal.repeat_of_id = the client's previous deal. Declared on the entity (Deal.repeat_of).
 */
export class DealRepeat1795000000000 implements MigrationInterface {
  name = 'DealRepeat1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deal" ADD "repeat_of_id" integer`);
    await queryRunner.query(`CREATE INDEX "IDX_deal_repeat_of" ON "deal" ("repeat_of_id")`);
    await queryRunner.query(
      `ALTER TABLE "deal" ADD CONSTRAINT "FK_deal_repeat_of" FOREIGN KEY ("repeat_of_id") REFERENCES "deal"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deal" DROP CONSTRAINT "FK_deal_repeat_of"`);
    await queryRunner.query(`DROP INDEX "IDX_deal_repeat_of"`);
    await queryRunner.query(`ALTER TABLE "deal" DROP COLUMN "repeat_of_id"`);
  }
}
