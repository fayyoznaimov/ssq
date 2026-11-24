import { DataSource, EntityManager } from 'typeorm';
import { ORDER_PARAMS, OpenItem, OrderParamKey, TurnFlag } from './ai-prompts';

/**
 * What the turn analyses of a deal add up to: the open questions and promises (conversation_item),
 * the latest value of each order parameter and the flags (conversation_turn). `withMail` false: what
 * comes from letters is left out (a reader without the "mail" right).
 */
type Db = DataSource | EntityManager;

export interface ItemRow extends OpenItem {
  event_id: number | null;
  status: string;
  close_reason: string | null;
  task_id: number | null;
  task_closed: boolean;
  has_email: boolean;
  created_at: Date;
  closed_at: Date | null;
}

export async function dealItems(db: Db, dealId: number, withMail: boolean, statuses: string[] = ['open'], limit = 50): Promise<ItemRow[]> {
  const rows = await db.query(
    `SELECT i.id, i.kind, i.who, i.text, i.event_id, i.status, i.close_reason, i.task_id, i.has_email, i.due_at, i.due_has_time,
            i.created_at, i.closed_at, (t.closed_at IS NOT NULL) AS task_closed
       FROM conversation_item i LEFT JOIN task t ON t.id = i.task_id
      WHERE i.deal_id = $1 AND i.status = ANY($2) AND ($3::boolean OR NOT i.has_email)
      ORDER BY i.id DESC LIMIT $4`,
    [dealId, statuses, withMail, limit],
  );
  return rows.reverse().map((r: any) => ({
    id: Number(r.id),
    kind: r.kind,
    who: r.who ?? null,
    text: r.text,
    event_id: r.event_id === null ? null : Number(r.event_id),
    status: r.status,
    close_reason: r.close_reason ?? null,
    task_id: r.task_id === null ? null : Number(r.task_id),
    task_closed: !!r.task_closed,
    has_email: !!r.has_email,
    due_at: r.due_at ? new Date(r.due_at) : null,
    due_has_time: !!r.due_has_time,
    created_at: new Date(r.created_at),
    closed_at: r.closed_at ? new Date(r.closed_at) : null,
  }));
}

export interface ParamValue {
  key: OrderParamKey;
  label: string;
  value: string;
  /** the turn it was named in last: its last message and time */
  event_id: number;
  at: Date;
}

/** The latest named value of each order parameter (newest turn first), from the last 50 turns. */
export async function latestParams(db: Db, dealId: number, withMail: boolean): Promise<ParamValue[]> {
  const turns = await db.query(
    `SELECT order_params, to_event_id, created_at FROM conversation_turn
      WHERE deal_id = $1 AND ($2::boolean OR NOT has_email) AND order_params IS NOT NULL
      ORDER BY to_event_id DESC LIMIT 50`,
    [dealId, withMail],
  );
  const out: ParamValue[] = [];
  for (const param of ORDER_PARAMS) {
    const turn = turns.find((t: any) => typeof t.order_params?.[param.key] === 'string' && t.order_params[param.key].trim());
    if (turn) {
      out.push({
        key: param.key,
        label: param.label,
        value: turn.order_params[param.key].trim(),
        event_id: Number(turn.to_event_id),
        at: new Date(turn.created_at),
      });
    }
  }
  return out;
}

/** Flags of the turns of the last `days`: how many turns had each, the newest. */
export async function recentFlags(
  db: Db,
  dealId: number,
  withMail: boolean,
  days = 30,
): Promise<{ flag: TurnFlag; count: number; last_at: Date; event_id: number }[]> {
  const rows = await db.query(
    `SELECT f.flag, count(*)::int AS count, MAX(t.created_at) AS last_at, MAX(t.to_event_id) AS event_id
       FROM conversation_turn t, jsonb_array_elements_text(COALESCE(t.flags, '[]'::jsonb)) AS f(flag)
      WHERE t.deal_id = $1 AND ($2::boolean OR NOT t.has_email) AND t.created_at > now() - make_interval(days => $3::int)
      GROUP BY f.flag ORDER BY MAX(t.created_at) DESC`,
    [dealId, withMail, days],
  );
  return rows.map((r: any) => ({ flag: r.flag, count: Number(r.count), last_at: new Date(r.last_at), event_id: Number(r.event_id) }));
}
