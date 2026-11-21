import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migrations1714480957899 implements MigrationInterface {
  name = 'Migrations1714480957899';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "collection" ("id" SERIAL NOT NULL, "name" character varying(255) NOT NULL, "is_active" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ad3f485bbc99d875491f44d7c85" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "deal_stage" ADD "color" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "deal_stage" ADD "collection_id" integer NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "deal_stage" ADD CONSTRAINT "FK_9f0629cbb9b94757cdc1bc87da8" FOREIGN KEY ("collection_id") REFERENCES "collection"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "deal_stage" DROP CONSTRAINT "FK_9f0629cbb9b94757cdc1bc87da8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "deal_stage" DROP COLUMN "collection_id"`,
    );
    await queryRunner.query(`ALTER TABLE "deal_stage" DROP COLUMN "color"`);
    await queryRunner.query(`DROP TABLE "collection"`);
  }
}
