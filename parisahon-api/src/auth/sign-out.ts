import { DataSource, EntityManager } from 'typeorm';

/**
 * Emitted (EventEmitter2) after signOutEverywhere(), with its result: the CRM bot tells the
 * unlinked Telegram chats why they are disconnected (bot.service.ts).
 */
export const SIGNED_OUT_EVENT = 'auth.signed-out-everywhere';

export interface SignedOut {
  userId: number;
  /** the new user.token_version: a token for the device that stays signed in carries it (claim "tv") */
  tokenVersion: number;
  /** Telegram chats of the CRM bot that were linked to the user and are unlinked now */
  chatIds: string[];
}

/** TypeORM answers [rows, count] to UPDATE / DELETE ... RETURNING on Postgres, plain rows otherwise. */
function returnedRows(result: any): any[] {
  return Array.isArray(result?.[0]) ? result[0] : Array.isArray(result) ? result : [];
}

/**
 * "Sign out everywhere": POST /auth/logout, POST /auth/logout/:id (admin), a new password (own or set
 * by the admin). Every login token issued so far stops working (user.token_version, compared by
 * AuthGuard on every request), and the user's Telegram chat with the CRM bot is unlinked
 * (bot_account): the bot acts as the user without any token, so after a lost phone or a stolen
 * password it must not keep working. The user links the bot again from the profile page.
 * Pass the EntityManager of a transaction to make it part of it (e.g. together with the new password);
 * emit SIGNED_OUT_EVENT with the result once the change is committed.
 */
export async function signOutEverywhere(db: DataSource | EntityManager, userId: number): Promise<SignedOut> {
  const bumped = returnedRows(
    await db.query(`UPDATE "user" SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version`, [userId]),
  );
  const unlinked = returnedRows(await db.query(`DELETE FROM bot_account WHERE user_id = $1 RETURNING chat_id`, [userId]));
  return {
    userId,
    tokenVersion: Number(bumped[0]?.token_version ?? 0),
    chatIds: unlinked.map((row) => String(row.chat_id)),
  };
}
