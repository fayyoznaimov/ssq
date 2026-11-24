import { DataSource, EntityManager } from 'typeorm';
import { EventTypes } from '../events/event.entity';
import { htmlToText, splitQuote } from '../email/mail-text';
import type { DealFacts } from './ai-prompts';

/**
 * The conversation of a deal as the AI reads it: the client's and the manager's messages in Telegram,
 * WhatsApp and e-mail (event types 12, 16, 9), oldest first. A letter is its subject and its own text
 * (no quoted earlier letters, no markup); attached files are named. Direction: incoming = the client,
 * outgoing = the manager (a letter by its own direction, as the mail assistant reads it).
 */
export const CHAT_EVENT_TYPES = [EventTypes.NEW_TELEGRAM_MESSAGE, EventTypes.NEW_WHATSAPP_MESSAGE, EventTypes.NEW_EMAIL];

export type Channel = 'telegram' | 'whatsapp' | 'email';

export interface ChatMessage {
  id: number;
  at: Date;
  from: 'client' | 'manager';
  channel: Channel;
  text: string;
}

const CHANNEL: Record<number, Channel> = {
  [EventTypes.NEW_TELEGRAM_MESSAGE]: 'telegram',
  [EventTypes.NEW_WHATSAPP_MESSAGE]: 'whatsapp',
  [EventTypes.NEW_EMAIL]: 'email',
};

const COLUMNS = `e.id, e.type, e.created_at,
  (CASE WHEN e.type = 9 THEN COALESCE(e.after_state->'data'->>'outgoing', e.outgoing::text) ELSE e.outgoing::text END) = 'true' AS outgoing,
  e.after_state->'data'->>'subject' AS subject,
  LEFT(CASE WHEN e.type = 9 THEN COALESCE(NULLIF(e.after_state->'data'->>'body', ''), e.after_state->'data'->>'html', '')
            ELSE COALESCE(e.after_state->>'message', e.after_state->>'text', e.after_state->'data'->>'message',
                          e.after_state->'data'->>'text', '') END, 20000) AS text,
  COALESCE(e.after_state->'files', e.after_state->'data'->'files') AS files`;

type Db = DataSource | EntityManager;

function toMessage(row: any, max: number): ChatMessage | null {
  const type = Number(row.type);
  let text: string;
  if (type === EventTypes.NEW_EMAIL) {
    const raw = String(row.text ?? '');
    const plain = /<[a-z][\s\S]*>/i.test(raw) ? htmlToText(raw) : raw;
    const { main } = splitQuote(plain);
    text = [row.subject ? `Тема: ${row.subject}.` : '', main].filter(Boolean).join(' ');
  } else {
    text = String(row.text ?? '');
  }
  text = text.replace(/\s+/g, ' ').trim();
  const files = Array.isArray(row.files)
    ? row.files.map((f: any) => (typeof f?.name === 'string' ? f.name : null)).filter(Boolean).slice(0, 3)
    : [];
  if (files.length) text = `${text} [файлы: ${files.join(', ')}]`.trim();
  if (!text) return null;
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return {
    id: Number(row.id),
    at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    from: row.outgoing ? 'manager' : 'client',
    channel: CHANNEL[type] ?? 'telegram',
    text,
  };
}

function toMessages(rows: any[], max: number): ChatMessage[] {
  return rows.map((row) => toMessage(row, max)).filter((m): m is ChatMessage => m !== null);
}

/** The newest `limit` messages of the deal after event `afterId`, within the last `days`, oldest first. */
export async function messagesAfter(db: Db, dealId: number, afterId: number, days: number, limit = 80, max = 1500): Promise<ChatMessage[]> {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM event e
      WHERE e.deal_id = $1 AND e.type = ANY($2) AND e.id > $3 AND e.created_at > now() - make_interval(days => $4::int)
      ORDER BY e.created_at DESC, e.id DESC LIMIT $5`,
    [dealId, CHAT_EVENT_TYPES, afterId, days, limit],
  );
  return toMessages(rows.reverse(), max);
}

/** Up to `limit` messages of the deal before the message `before` (for context), oldest first. */
export async function messagesBefore(db: Db, dealId: number, before: ChatMessage, limit = 8, max = 600): Promise<ChatMessage[]> {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM event e
      WHERE e.deal_id = $1 AND e.type = ANY($2) AND (e.created_at, e.id) < ($3::timestamp, $4::int)
      ORDER BY e.created_at DESC, e.id DESC LIMIT $5`,
    [dealId, CHAT_EVENT_TYPES, before.at, before.id, limit],
  );
  return toMessages(rows.reverse(), max);
}

/** The messages with these ids that are still in the deal, oldest first. */
export async function messagesByIds(db: Db, dealId: number, ids: number[], max = 1500): Promise<ChatMessage[]> {
  if (!ids.length) return [];
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM event e WHERE e.deal_id = $1 AND e.type = ANY($2) AND e.id = ANY($3)
      ORDER BY e.created_at, e.id`,
    [dealId, CHAT_EVENT_TYPES, ids],
  );
  return toMessages(rows, max);
}

/** The latest `limit` messages of the deal (letters only with `withMail`), oldest first. */
export async function recentMessages(db: Db, dealId: number, withMail: boolean, limit = 40, max = 800): Promise<ChatMessage[]> {
  const types = withMail ? CHAT_EVENT_TYPES : CHAT_EVENT_TYPES.filter((t) => t !== EventTypes.NEW_EMAIL);
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM event e WHERE e.deal_id = $1 AND e.type = ANY($2)
      ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
    [dealId, types, limit],
  );
  return toMessages(rows.reverse(), max);
}

export type DealRow = DealFacts & { agent_id: number | null; group_id: number | null; closed: boolean };

/** What the prompts say about the deal, and who is responsible for it; null when it is deleted. */
export async function loadDeal(db: Db, dealId: number): Promise<DealRow | null> {
  const rows = await db.query(
    `SELECT d.id, d.display_id, d.label, d.budget, d.closed_at, d.deleted_at, d.agent_id, a.group_id,
            s.name AS stage, c.name AS company
       FROM deal d LEFT JOIN deal_stage s ON s.id = d.stage_id LEFT JOIN "user" a ON a.id = d.agent_id
       LEFT JOIN company c ON c.id = d.company_id
      WHERE d.id = $1`,
    [dealId],
  );
  const d = rows[0];
  if (!d || d.deleted_at) return null;
  const products = await db.query(
    `SELECT p.name, dp.quantity, dp.price FROM deal_product dp JOIN product p ON p.id = dp.product_id
      WHERE dp.deal_id = $1 ORDER BY p.name LIMIT 20`,
    [dealId],
  );
  return {
    id: Number(d.id),
    number: d.display_id === null || d.display_id === undefined ? null : Number(d.display_id),
    label: d.label,
    stage: d.stage ?? null,
    company: d.company ?? null,
    budget: d.budget ?? null,
    products: products.map((p: any) => `${p.name} — ${p.quantity} × ${p.price}`),
    agent_id: d.agent_id ?? null,
    group_id: d.group_id ?? null,
    closed: !!d.closed_at,
  };
}

export type MessageRef = { at: Date; from: 'client' | 'manager' | 'note'; channel: Channel | 'note'; excerpt: string };

/**
 * A short excerpt of each message (or internal note) for the references on the deal page; letters
 * only with `withMail`. Ids of other deals or of other kinds of events are left out.
 */
export async function messageRefs(db: Db, dealId: number, ids: number[], withMail: boolean): Promise<Record<number, MessageRef>> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id)))];
  if (!unique.length) return {};
  const types = withMail ? CHAT_EVENT_TYPES : CHAT_EVENT_TYPES.filter((t) => t !== EventTypes.NEW_EMAIL);
  const rows = await db.query(`SELECT ${COLUMNS} FROM event e WHERE e.deal_id = $1 AND e.type = ANY($2) AND e.id = ANY($3)`, [
    dealId,
    types,
    unique,
  ]);
  const out: Record<number, MessageRef> = {};
  for (const m of toMessages(rows, 160)) out[m.id] = { at: m.at, from: m.from, channel: m.channel, excerpt: m.text };
  for (const note of await dealNotes(db, dealId, 50, 160, unique)) out[note.id] = { at: note.at, from: 'note', channel: 'note', excerpt: note.text };
  return out;
}

/** An internal note of the deal (a comment of the staff, event type 5). */
export interface DealNote {
  id: number;
  at: Date;
  author: string | null;
  text: string;
}

/** The latest `limit` notes of the deal (only these ids with `onlyIds`), oldest first: context of the summary. */
export async function dealNotes(db: Db, dealId: number, limit = 10, max = 500, onlyIds?: number[]): Promise<DealNote[]> {
  const params: unknown[] = [dealId, EventTypes.NEW_COMMENT, limit];
  if (onlyIds) params.push(onlyIds);
  const rows = await db.query(
    `SELECT e.id, e.created_at, u.username AS author, LEFT(COALESCE(e.after_state->'data'->>'comment', ''), 4000) AS text
       FROM event e LEFT JOIN "user" u ON u.id = e.user_id
      WHERE e.deal_id = $1 AND e.type = $2 ${onlyIds ? 'AND e.id = ANY($4)' : ''}
      ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
    params,
  );
  return rows
    .reverse()
    .map((row: any) => {
      let text = String(row.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > max) text = `${text.slice(0, max - 1)}…`;
      return { id: Number(row.id), at: new Date(row.created_at), author: row.author ?? null, text };
    })
    .filter((note: DealNote) => note.text);
}

/** An open task of the deal: what is already planned (the summary's next step must not repeat it blindly). */
export interface DealTask {
  id: number;
  label: string;
  due: Date | null;
  agent: string | null;
}

export async function openTasks(db: Db, dealId: number, limit = 10): Promise<DealTask[]> {
  const rows = await db.query(
    `SELECT t.id, t.label, t.end_time, u.username AS agent FROM task t LEFT JOIN "user" u ON u.id = t.agent_id
      WHERE t.deal_id = $1 AND t.closed_at IS NULL ORDER BY t.end_time, t.id LIMIT $2`,
    [dealId, limit],
  );
  return rows.map((row: any) => ({
    id: Number(row.id),
    label: String(row.label ?? '').slice(0, 255),
    due: row.end_time ? new Date(row.end_time) : null,
    agent: row.agent ?? null,
  }));
}
