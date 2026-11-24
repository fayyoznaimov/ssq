/**
 * One messenger message = one key: the manager's account, the chat (the client) and the message id
 * (DB-6). In the `event` table:
 *  - account = the manager: user_id of an outgoing message, target_user_id of an incoming one;
 *  - chat = the client: the other of the two;
 *  - Telegram: tg_message_id (type 12), WhatsApp: external_id (type 16).
 * The unique indexes IDX_event_tg_message_key / IDX_event_wa_message_key (migration
 * 1795680000000-messenger-message-key) hold it, so a message delivered twice at the same time is
 * stored once; the inboxes look it up by the same expressions (the index serves the lookup).
 *
 * Per-chat lock: the deliveries of one chat are handled one after another inside this API process
 * (choosing the deal, maybe creating it, writing the event), so two copies of a first message do not
 * open two deals. The unique index is the guard across processes.
 */
export const ACCOUNT_SQL = '(CASE WHEN outgoing THEN user_id ELSE target_user_id END)';
export const CHAT_SQL = '(CASE WHEN outgoing THEN target_user_id ELSE user_id END)';

/** Postgres unique_violation (the same message stored by a parallel delivery). */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; driverError?: { code?: string } } | null;
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

const tails = new Map<string, Promise<unknown>>();

/** Runs `job` after every earlier job of the same key has finished (in this process). */
export async function withChatLock<T>(key: string, job: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = before.then(() => mine);
  tails.set(key, tail);
  try {
    await before.catch(() => undefined);
    return await job();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
