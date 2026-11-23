import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventTypes } from '../events/event.entity';

/**
 * "Контроль менеджеров": how fast and whether the managers answer the clients.
 *
 * A turn = a client's message (or several in a row) in a deal's chat history and the manager's
 * next answer in that deal, whatever the channel (Telegram, WhatsApp, e-mail, SMS). An outgoing
 * call to the client is an answer too (the manager called back); an incoming call does not start
 * a turn. The same rule is used by «клиент ждёт ответа» (BotWaitingService) and the autopilot:
 * clientMessageSql / answerSql.
 * Waiting time counts working hours only (CONTROL_WORK_HOURS, default 09:00-18:00, and
 * CONTROL_WORK_DAYS, default Monday to Saturday, server time zone).
 * A turn is "late" when the answer came after the norm (sla_minutes, default 15) or it is still
 * unanswered past the norm. Calls: recordings of the period by manager.
 * «Ждут ответа сейчас» does not depend on the period: open deals where the client wrote last,
 * within CONTROL_WAITING_DAYS (30).
 *
 * Also fills event.replied_at of answered client messages every 5 minutes (the manager statistics
 * page reads it).
 */
export const CHAT_TYPES = [
  EventTypes.NEW_EMAIL,
  EventTypes.NEW_SMS,
  EventTypes.NEW_TELEGRAM_MESSAGE,
  EventTypes.NEW_WHATSAPP_MESSAGE,
];

/** What a manager answers a client with when it is outgoing: a chat message, or a call (calling back answers too). */
export const ANSWER_TYPES = [...CHAT_TYPES, EventTypes.NEW_CALL_RECORDING];

/** SQL: the event `e` is a client's message waiting for an answer (incoming chat). Bind CHAT_TYPES to `types`. */
export function clientMessageSql(e: string, types: string): string {
  return `(NOT ${e}.outgoing AND ${e}.type = ANY(${types}))`;
}

/** SQL: the event `e` is the manager's answer (an outgoing chat message or an outgoing call). Bind ANSWER_TYPES to `types`. */
export function answerSql(e: string, types: string): string {
  return `(${e}.outgoing AND ${e}.type = ANY(${types}))`;
}

const CHANNEL: Record<number, string> = {
  [EventTypes.NEW_EMAIL]: 'email',
  [EventTypes.NEW_SMS]: 'sms',
  [EventTypes.NEW_TELEGRAM_MESSAGE]: 'telegram',
  [EventTypes.NEW_WHATSAPP_MESSAGE]: 'whatsapp',
};

export interface ControlQuery {
  from: Date;
  till: Date;
  slaMinutes: number;
  waitingHours: number;
  agentId?: number;
}

interface Turn {
  id: number;
  deal_id: number;
  deal_label: string;
  deal_agent_id: number | null;
  type: number;
  asked_at: Date;
  text: string | null;
  answered_at: Date | null;
  answered_by: number | null;
  first_of_deal: boolean;
  contact_name: string | null;
}

interface Waiting {
  deal_id: number;
  deal_label: string;
  deal_agent_id: number | null;
  type: number;
  asked_at: Date;
  text: string | null;
  contact_name: string | null;
}

/** Working schedule: hours of a day and days of a week (1 Monday ... 7 Sunday). */
export class WorkSchedule {
  readonly startMin: number;
  readonly endMin: number;
  readonly days: Set<number>;

  constructor(hours = process.env.CONTROL_WORK_HOURS || '09:00-18:00', days = process.env.CONTROL_WORK_DAYS || '1-6') {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(hours.trim());
    this.startMin = m ? Number(m[1]) * 60 + Number(m[2]) : 9 * 60;
    this.endMin = m ? Number(m[3]) * 60 + Number(m[4]) : 18 * 60;
    this.days = new Set<number>();
    for (const part of days.split(',')) {
      const [a, b] = part.split('-').map((x) => Number(x.trim()));
      if (!a) continue;
      for (let d = a; d <= (b || a); d++) this.days.add(d);
    }
    if (this.days.size === 0) [1, 2, 3, 4, 5, 6].forEach((d) => this.days.add(d));
  }

  /** Working seconds between two moments (local server time). */
  seconds(from: Date, to: Date): number {
    if (to <= from) return 0;
    let total = 0;
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    for (let guard = 0; day < to && guard < 800; guard++) {
      const weekday = day.getDay() === 0 ? 7 : day.getDay();
      if (this.days.has(weekday)) {
        const open = new Date(day.getTime() + this.startMin * 60000);
        const close = new Date(day.getTime() + this.endMin * 60000);
        const a = Math.max(open.getTime(), from.getTime());
        const b = Math.min(close.getTime(), to.getTime());
        if (b > a) total += (b - a) / 1000;
      }
      day.setDate(day.getDate() + 1);
    }
    return Math.round(total);
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

@Injectable()
export class ControlService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ControlService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private dataSource: DataSource) {}

  onModuleInit(): void {
    if (process.env.CONTROL_REPLIED_SEC === '0') return;
    const every = Math.max(30, Number(process.env.CONTROL_REPLIED_SEC || 300)) * 1000;
    this.timer = setInterval(() => this.fillRepliedAt().catch((e) => this.logger.warn(`replied_at: ${e.message}`)), every);
    setTimeout(() => this.fillRepliedAt().catch((e) => this.logger.warn(`replied_at: ${e.message}`)), 15000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private filling = false;

  /**
   * event.replied_at of client messages that got an answer in the same deal. Looks at the last 30
   * days only (CONTROL_REPLIED_DAYS), so the periodic run stays cheap however old the database is.
   */
  async fillRepliedAt(): Promise<number> {
    if (this.filling) return 0;
    this.filling = true;
    try {
      return await this.fillRepliedAtOnce();
    } finally {
      this.filling = false;
    }
  }

  private async fillRepliedAtOnce(): Promise<number> {
    const days = Math.max(1, Number(process.env.CONTROL_REPLIED_DAYS || 30));
    const result = await this.dataSource.query(
      `UPDATE event q SET replied_at = a.at
         FROM (
           SELECT c.id, (SELECT MIN(m.created_at) FROM event m
                          WHERE m.deal_id = c.deal_id AND ${answerSql('m', '$3')}
                            AND (m.created_at, m.id) > (c.created_at, c.id)) AS at
             FROM event c
            WHERE c.type = ANY($1) AND NOT c.outgoing AND c.replied_at IS NULL AND c.deal_id IS NOT NULL
              AND c.created_at > now() - make_interval(days => $2::int)
         ) a
        WHERE q.id = a.id AND a.at IS NOT NULL`,
      [CHAT_TYPES, days, ANSWER_TYPES],
    );
    return Array.isArray(result) ? Number(result[1] ?? 0) : 0;
  }

  /**
   * The turns that started in the period, with their answers, which may come later (also after
   * the end of the period: a past period does not show answered clients as unanswered).
   */
  private async turns(q: ControlQuery): Promise<Turn[]> {
    return this.dataSource.query(
      `WITH msg AS (
         SELECT e.id, e.deal_id, e.type, e.outgoing, e.created_at,
                -- the author of an answer: the sender; of a call, the employee on it (an outgoing call
                -- is the manager's, user_id; older rows kept the manager as target_user)
                CASE WHEN au.role IN ('admin', 'manager', 'agent') THEN au.id
                     WHEN tu.role IN ('admin', 'manager', 'agent') THEN tu.id END AS author_id,
                COALESCE(e.after_state->>'message', e.after_state->>'text', e.after_state->'data'->>'subject') AS text,
                LAG(e.outgoing) OVER (PARTITION BY e.deal_id ORDER BY e.created_at, e.id) AS prev_out,
                ROW_NUMBER() OVER (PARTITION BY e.deal_id ORDER BY e.created_at, e.id) AS n
           FROM event e
           JOIN deal d ON d.id = e.deal_id AND d.deleted_at IS NULL
           LEFT JOIN "user" au ON au.id = e.user_id
           LEFT JOIN "user" tu ON tu.id = e.target_user_id AND e.type = ${EventTypes.NEW_CALL_RECORDING}
          WHERE ${clientMessageSql('e', '$1')} OR ${answerSql('e', '$4')}
       ),
       starts AS (
         SELECT * FROM msg WHERE NOT outgoing AND (prev_out IS NULL OR prev_out)
       )
       SELECT s.id, s.deal_id, d.label AS deal_label, d.agent_id AS deal_agent_id, s.type, s.created_at AS asked_at,
              LEFT(s.text, 300) AS text, s.n = 1 AS first_of_deal,
              ans.created_at AS answered_at, ans.author_id AS answered_by,
              cu.username AS contact_name
         FROM starts s
         JOIN deal d ON d.id = s.deal_id
         LEFT JOIN LATERAL (
           SELECT m.created_at, m.author_id FROM msg m
            WHERE m.deal_id = s.deal_id AND m.outgoing AND (m.created_at, m.id) > (s.created_at, s.id)
            ORDER BY m.created_at, m.id LIMIT 1
         ) ans ON TRUE
         LEFT JOIN event se ON se.id = s.id
         LEFT JOIN LATERAL (
           SELECT u.username FROM "user" u
            WHERE u.id IN (se.target_user_id, se.user_id) AND u.role = 'ctr_agent' LIMIT 1
         ) cu ON TRUE
        WHERE s.created_at >= $2 AND s.created_at < $3
        ORDER BY s.created_at`,
      [CHAT_TYPES, q.from, q.till, ANSWER_TYPES],
    );
  }

  /**
   * «Ждут ответа сейчас», whatever the period: per open deal (not in a closed stage) the first
   * client message after the last answer, within CONTROL_WAITING_DAYS (30) — the same rule as
   * the reminders of BotWaitingService.
   */
  private async waitingNow(closedStages: string[]): Promise<Waiting[]> {
    const days = Math.max(1, Number(process.env.CONTROL_WAITING_DAYS || 30));
    return this.dataSource.query(
      `SELECT d.id AS deal_id, d.label AS deal_label, d.agent_id AS deal_agent_id, q.type, q.created_at AS asked_at,
              LEFT(COALESCE(q.after_state->>'message', q.after_state->>'text', q.after_state->'data'->>'subject'), 300) AS text,
              (SELECT u.username FROM "user" u
                WHERE u.id IN (q.target_user_id, q.user_id) AND u.role = 'ctr_agent' LIMIT 1) AS contact_name
         FROM deal d
         LEFT JOIN deal_stage s ON s.id = d.stage_id
         JOIN LATERAL (
           SELECT e.* FROM event e
            WHERE e.deal_id = d.id AND ${clientMessageSql('e', '$1')}
              AND e.created_at > COALESCE((SELECT MAX(o.created_at) FROM event o
                                            WHERE o.deal_id = d.id AND ${answerSql('o', '$2')}), '-infinity')
            ORDER BY e.created_at, e.id LIMIT 1
         ) q ON TRUE
        WHERE d.deleted_at IS NULL AND d.closed_at IS NULL AND NOT (COALESCE(s.name, '') = ANY($3))
          AND q.created_at > now() - make_interval(days => $4::int)
          AND d.id IN (SELECT r.deal_id FROM event r
                        WHERE ${clientMessageSql('r', '$1')} AND r.created_at > now() - make_interval(days => $4::int))`,
      [CHAT_TYPES, ANSWER_TYPES, closedStages, days],
    );
  }

  async report(q: ControlQuery) {
    const schedule = new WorkSchedule();
    const now = new Date();
    const sla = q.slaMinutes * 60;
    const waitLimit = q.waitingHours * 3600;
    // DEAL_STAGE_CLOSED* are stage names
    const closedStages = [process.env.DEAL_STAGE_CLOSED, process.env.DEAL_STAGE_CLOSED_NOT_REALIZED].filter(Boolean);

    const [turns, staff, deals, calls, waitingRows] = await Promise.all([
      this.turns(q),
      this.dataSource.query(
        `SELECT id, username FROM "user" WHERE role IN ('admin','manager','agent') AND deleted_at IS NULL ORDER BY username`,
      ),
      this.dataSource.query(
        `SELECT d.id, d.agent_id,
                (SELECT e.type FROM event e WHERE e.deal_id = d.id AND e.type = ANY($3) ORDER BY e.created_at, e.id LIMIT 1) AS first_type
           FROM deal d WHERE d.deleted_at IS NULL AND d.created_at >= $1 AND d.created_at < $2`,
        [q.from, q.till, [...CHAT_TYPES, EventTypes.NEW_CALL_RECORDING]],
      ),
      this.dataSource.query(
        `SELECT user_id, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE outgoing)::int AS outgoing,
                COALESCE(SUM(duration), 0)::bigint AS duration_ms
           FROM recording WHERE created_at >= $1 AND created_at < $2 GROUP BY user_id`,
        [q.from, q.till],
      ),
      this.waitingNow(closedStages),
    ]);

    type Row = {
      id: number; name: string; leads: number; calls: number; outgoing_calls: number; call_minutes: number;
      turns: number; answered: number; in_sla: number; late: number; unanswered: number;
      waits: number[]; first: number[];
    };
    const byAgent = new Map<number, Row>();
    // deals whose responsible user is missing or not staff (old data) are grouped as id 0
    const row = (raw: number | null): Row | null => {
      const s = staff.find((x: any) => x.id === raw);
      const id = s ? s.id : 0;
      if (!byAgent.has(id)) {
        byAgent.set(id, {
          id, name: s?.username ?? 'Без ответственного', leads: 0, calls: 0, outgoing_calls: 0, call_minutes: 0,
          turns: 0, answered: 0, in_sla: 0, late: 0, unanswered: 0, waits: [], first: [],
        });
      }
      return byAgent.get(id)!;
    };

    const channels: Record<string, number> = {};
    for (const d of deals) {
      if (q.agentId && d.agent_id !== q.agentId) continue;
      const r = row(d.agent_id);
      if (r) r.leads += 1;
      const ch = d.first_type === EventTypes.NEW_CALL_RECORDING ? 'calls' : CHANNEL[d.first_type] ?? 'other';
      channels[ch] = (channels[ch] ?? 0) + 1;
    }
    for (const c of calls) {
      if (q.agentId && c.user_id !== q.agentId) continue;
      const r = row(c.user_id);
      if (!r) continue;
      r.calls += c.calls;
      r.outgoing_calls += c.outgoing;
      r.call_minutes += Math.round(Number(c.duration_ms) / 60000);
    }

    const allWaits: number[] = [];
    const firstWaits: number[] = [];
    let inSla = 0, late = 0, measured = 0;
    for (const t of turns) {
      const agentId = t.answered_by ?? t.deal_agent_id;
      if (q.agentId && agentId !== q.agentId) continue;
      const r = row(agentId);
      const end = t.answered_at ? new Date(t.answered_at) : now;
      const wait = schedule.seconds(new Date(t.asked_at), end);
      if (r) r.turns += 1;
      if (t.answered_at) {
        if (r) { r.answered += 1; r.waits.push(wait); if (t.first_of_deal) r.first.push(wait); }
        allWaits.push(wait);
        if (t.first_of_deal) firstWaits.push(wait);
        measured += 1;
        if (wait <= sla) { inSla += 1; if (r) r.in_sla += 1; } else { late += 1; if (r) r.late += 1; }
      } else if (wait > sla) {
        measured += 1;
        late += 1;
        if (r) { r.late += 1; r.unanswered += 1; }
      }
    }

    // who waits now, whatever the period
    const waiting: any[] = [];
    for (const w of waitingRows) {
      if (q.agentId && w.deal_agent_id !== q.agentId) continue;
      const wait = schedule.seconds(new Date(w.asked_at), now);
      if (wait <= sla || wait < waitLimit) continue;
      const s = staff.find((x: any) => x.id === w.deal_agent_id);
      waiting.push({
        deal_id: w.deal_id, deal_label: w.deal_label, contact_name: w.contact_name,
        channel: CHANNEL[w.type] ?? 'other', text: w.text, agent_id: w.deal_agent_id,
        agent_name: s?.username ?? null, asked_at: w.asked_at, waiting_seconds: wait,
      });
    }
    waiting.sort((a, b) => b.waiting_seconds - a.waiting_seconds);

    const agents = [...byAgent.values()]
      .map((r) => ({
        id: r.id, name: r.name, leads: r.leads, calls: r.calls, outgoing_calls: r.outgoing_calls,
        call_minutes: r.call_minutes, turns: r.turns, answered: r.answered, late: r.late, unanswered: r.unanswered,
        first_response_median_sec: median(r.first), response_median_sec: median(r.waits),
        response_p90_sec: percentile(r.waits, 90),
        in_sla_share: r.in_sla + r.late > 0 ? Math.round((r.in_sla / (r.in_sla + r.late)) * 100) : null,
      }))
      .sort((a, b) => b.turns + b.leads + b.calls - (a.turns + a.leads + a.calls));

    return {
      period: { from: q.from, till: q.till },
      norm: {
        sla_minutes: q.slaMinutes, waiting_hours: q.waitingHours,
        work_hours: process.env.CONTROL_WORK_HOURS || '09:00-18:00', work_days: process.env.CONTROL_WORK_DAYS || '1-6',
        // what counts as an answer, for the page
        answer: 'message_or_outgoing_call',
      },
      summary: {
        new_deals: deals.filter((d: any) => !q.agentId || d.agent_id === q.agentId).length,
        by_channel: channels,
        first_response_median_sec: median(firstWaits),
        response_median_sec: median(allWaits),
        response_p90_sec: percentile(allWaits, 90),
        in_sla_share: measured > 0 ? Math.round((inSla / measured) * 100) : null,
        late,
        waiting_now: waiting.length,
        calls: agents.reduce((s, a) => s + a.calls, 0),
      },
      agents,
      waiting: waiting.slice(0, 50),
    };
  }
}
