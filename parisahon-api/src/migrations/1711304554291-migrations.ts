import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1711304554291 implements MigrationInterface {
    name = 'Migrations1711304554291'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "deal_product" ("id" SERIAL NOT NULL, "quantity" bigint NOT NULL, "price" bigint NOT NULL, "deal_id" integer, "product_id" integer, CONSTRAINT "PK_a76c368ef4373c0b58996a1ff6a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "product" ("id" SERIAL NOT NULL, "name" character varying(255) NOT NULL, "deleted_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" integer, "updated_by" integer, CONSTRAINT "PK_bebc9158e480b949565b4dc7a82" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "product_filler" ("id" SERIAL NOT NULL, "value" character varying(255) NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "product_id" integer NOT NULL, "filler_id" integer NOT NULL, CONSTRAINT "PK_157100691921534662d19283742" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "deal_product" ADD CONSTRAINT "FK_ecf7d48d44957521b0b7588cdd5" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "deal_product" ADD CONSTRAINT "FK_fb43ba6554f7727d4bdb1de996d" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "product" ADD CONSTRAINT "FK_b5effca691499d21c5ec683ced6" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "product" ADD CONSTRAINT "FK_f2d871fad6c5e683b6111948f3d" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "product_filler" ADD CONSTRAINT "FK_acf052752229d4f4b8519c7f110" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "product_filler" ADD CONSTRAINT "FK_962915e33d631e76a0a432a0275" FOREIGN KEY ("filler_id") REFERENCES "filler"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "product_filler" DROP CONSTRAINT "FK_962915e33d631e76a0a432a0275"`);
        await queryRunner.query(`ALTER TABLE "product_filler" DROP CONSTRAINT "FK_acf052752229d4f4b8519c7f110"`);
        await queryRunner.query(`ALTER TABLE "product" DROP CONSTRAINT "FK_f2d871fad6c5e683b6111948f3d"`);
        await queryRunner.query(`ALTER TABLE "product" DROP CONSTRAINT "FK_b5effca691499d21c5ec683ced6"`);
        await queryRunner.query(`ALTER TABLE "deal_product" DROP CONSTRAINT "FK_fb43ba6554f7727d4bdb1de996d"`);
        await queryRunner.query(`ALTER TABLE "deal_product" DROP CONSTRAINT "FK_ecf7d48d44957521b0b7588cdd5"`);
        await queryRunner.query(`DROP TABLE "product_filler"`);
        await queryRunner.query(`DROP TABLE "product"`);
        await queryRunner.query(`DROP TABLE "deal_product"`);
    }

}
