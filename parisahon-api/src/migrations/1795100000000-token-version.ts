import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * user.token_version: part of every login token (claim "tv"). Raising it signs the user out on
 * every device: password change (own or by the admin), POST /auth/logout, a role or rights change.
 * Tokens issued before this column existed carry no "tv" and count as version 0.
 */
export class TokenVersion1795100000000 implements MigrationInterface {
  name = 'TokenVersion1795100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "token_version" integer NOT NULL DEFAULT 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS "token_version"`);
  }
}
