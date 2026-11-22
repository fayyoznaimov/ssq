import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BotService } from './bot.service';
import { CHAT_TYPES, WorkSchedule } from '../analytics/control.service';
import { AUTO_REPLY, AutoTaskService } from '../automation/auto-task.service';

/**
 * Business process «Клиент ждёт ответа» (see «Контроль менеджеров»):
 *  1. the client wrote last and has waited longer than the norm (CONTROL_SLA_MINUTES, 15) in working
 *     time -> the responsible manager gets a reminder in the CRM bot; a manager who has not linked the
 *     bot gets a task «Авто: ответьте клиенту» instead (it closes itself when the answer is sent);
 *  2. still unanswered after CONTROL_ESCALATE_HOURS (2) working hours -> the admins and managers
 *     linked to the bot get a message too.
 * Once per client message and level (table control_notice), only during working hours, only for
 * messages of the last 3 days and open deals. CONTROL_NOTIFY=0 turns it off, CONTROL_TASK_FALLBACK=0
 * only the tasks. Works without the bot too (then only the tasks).
 */
@Injectable()
export class BotWaitingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BotWaitingService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private dataSource: DataSource,
    private bot: BotService,
    private autoTasks: AutoTaskService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.CONTROL_NOTIFY === '0') return;
    const every = Math.max(60, Number(process.env.CONTROL_NOTIFY_SEC || 300));
    this.timer = setInterval(() => void this.tick(), every * 1000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await this.run(now);
    } catch (error) {
      this.logger.warn(`waiting clients: ${(error as Error).message}`);
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  private async run(now: Date): Promise<number> {
    const schedule = new WorkSchedule();
    // only while the office works: a reminder at night helps nobody
    if (schedule.seconds(new Date(now.getTime() - 60_000), now) === 0) return 0;
    const sla = Number(process.env.CONTROL_SLA_MINUTES || 15) * 60;
    const escalate = Number(process.env.CONTROL_ESCALATE_HOURS || 2) * 3600;

    // per open deal with a recent client message: the first client message after the last answer
    const waiting: any[] = await this.dataSource.query(
      `SELECT d.id AS deal_id, d.display_id, d.label, d.agent_id, q.id AS event_id, q.type, q.created_at AS asked_at,
              LEFT(COALESCE(q.after_state->>'message', q.after_state->>'text', q.after_state->'email'->>'subject', ''), 200) AS text
         FROM deal d
         JOIN LATERAL (
           SELECT e.* FROM event e
            WHERE e.deal_id = d.id AND e.type = ANY($1) AND NOT e.outgoing
              AND e.created_at > COALESCE((SELECT MAX(o.created_at) FROM event o
                                            WHERE o.deal_id = d.id AND o.type = ANY($1) AND o.outgoing), '-infinity')
            ORDER BY e.created_at, e.id LIMIT 1
         ) q ON TRUE
        WHERE d.deleted_at IS NULL AND d.closed_at IS NULL AND q.created_at > now() - interval '3 days'
          AND d.id IN (SELECT r.deal_id FROM event r
                        WHERE r.type = ANY($1) AND NOT r.outgoing AND r.created_at > now() - interval '3 days')`,
      [CHAT_TYPES],
    );
    if (waiting.length === 0) return 0;

    const notified: any[] = await this.dataSource.query(
      `SELECT event_id, level FROM control_notice WHERE event_id = ANY($1)`,
      [waiting.map((w) => w.event_id)],
    );
    const done = new Set(notified.map((n) => `${n.event_id}:${n.level}`));
    const chats: any[] = this.bot.enabled
      ? await this.dataSource.query(
          `SELECT ba.user_id, ba.chat_id, u.role FROM bot_account ba JOIN "user" u ON u.id = ba.user_id AND u.deleted_at IS NULL`,
        )
      : [];
    const chatOf = new Map<number, string>(chats.map((c) => [Number(c.user_id), String(c.chat_id)]));
    const bosses = chats.filter((c) => c.role === 'admin' || c.role === 'manager');
    const base = (process.env.CRM_PUBLIC_URL || '').replace(/\/+$/, '');
    const channel: Record<number, string> = { 9: 'почта', 11: 'SMS', 12: 'Telegram', 16: 'WhatsApp' };
    const tasksOn = process.env.CONTROL_TASK_FALLBACK !== '0';

    let sent = 0;
    for (const w of waiting) {
      const asked = new Date(w.asked_at);
      const wait = schedule.seconds(asked, now);
      const minutes = Math.round(wait / 60);
      const where = `сделка №${w.display_id} «${w.label}» (${channel[w.type] ?? 'чат'})`;
      const quote = w.text ? `\n«${w.text}»` : '';
      const link = base ? `\n${base}/deals/${w.deal_id}` : '';

      if (wait >= sla && !done.has(`${w.event_id}:1`)) {
        const chat = w.agent_id ? chatOf.get(Number(w.agent_id)) : undefined;
        if (chat) {
          await this.bot.send(chat, `Клиент ждёт ответа ${minutes} мин: ${where}.${quote}${link}`).catch(() => undefined);
          sent++;
        } else if (w.agent_id && tasksOn && !(await this.hasOpenReplyTask(w.deal_id))) {
          const since = asked.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
          const label = `${AUTO_REPLY} (${channel[w.type] ?? 'чат'}, ждёт с ${since})`;
          if (await this.autoTasks.create(w.deal_id, label, new Date(now.getTime() + 30 * 60_000))) sent++;
        }
        await this.mark(w.event_id, 1);
      }
      if (wait >= escalate && !done.has(`${w.event_id}:2`)) {
        const agent = w.agent_id
          ? (await this.dataSource.query(`SELECT username FROM "user" WHERE id = $1`, [w.agent_id]))[0]?.username
          : null;
        for (const boss of bosses) {
          if (Number(boss.user_id) === Number(w.agent_id)) continue;
          await this.bot
            .send(boss.chat_id, `Без ответа уже ${Math.floor(minutes / 60)} ч ${minutes % 60} мин: ${where}, ответственный ${agent ?? 'не назначен'}.${quote}${link}`)
            .catch(() => undefined);
          sent++;
        }
        await this.mark(w.event_id, 2);
      }
    }
    if (sent) this.logger.log(`waiting clients: ${sent} reminder(s) sent`);
    return sent;
  }

  private async hasOpenReplyTask(dealId: number): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM task WHERE deal_id = $1 AND closed_at IS NULL AND label LIKE $2 LIMIT 1`,
      [dealId, `${AUTO_REPLY}%`],
    );
    return rows.length > 0;
  }

  private async mark(eventId: number, level: number) {
    await this.dataSource.query(
      `INSERT INTO control_notice (event_id, level) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [eventId, level],
    );
  }
}
