/**
 * What a reader of a history may see of the employees in it (SALE-16). The feeds give every author and
 * addressee as {id, username, avatar, role, deleted_at} (FEED_PERSON); the JSON snapshots of older rows
 * still held whole accounts (a deal of a task with its responsible, the creator of a contact): their
 * rights, goals, Telegram / WhatsApp ids, token versions. GET /users hides those from agents, the
 * feeds and the journal must not give them away either. Migration 1795610000000-event-client cleans
 * the stored rows by the same rule; this keeps any row that is written with them later out of the API.
 */
const SECRET_KEYS = new Set(['permissions', 'objectives', 'token_version', 'password', 'refresh_token']);
const STAFF_ONLY_KEYS = new Set(['tg_id', 'wa_id']);

function isStaff(value: Record<string, any>): boolean {
  return (
    'permissions' in value ||
    'objectives' in value ||
    'token_version' in value ||
    (typeof value.role === 'string' && value.role !== 'ctr_agent' && 'username' in value)
  );
}

/** A copy of a snapshot without the private fields of employees; a contact keeps its own (client) data. */
export function withoutStaffSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutStaffSecrets(item)) as unknown as T;
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const source = value as Record<string, any>;
  const staff = isStaff(source);
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(source)) {
    if (SECRET_KEYS.has(key)) continue;
    if (staff && STAFF_ONLY_KEYS.has(key)) continue;
    out[key] = withoutStaffSecrets(item);
  }
  return out as T;
}

/** The snapshots of the rows of a feed page, in place. */
export function stripFeedSnapshots<T extends { after_state?: any; before_state?: any }>(rows: T[] | undefined): void {
  for (const row of rows ?? []) {
    if (row.after_state) row.after_state = withoutStaffSecrets(row.after_state);
    if (row.before_state) row.before_state = withoutStaffSecrets(row.before_state);
  }
}
