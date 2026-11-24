import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AI, AiPriority } from '../ai/ai.config';
import { AiFormatError, AiJobRow, AiOutcome, AiQueueService, sha256 } from '../ai/ai-queue.service';
import { ANSWER_TYPES, CHAT_TYPES, ControlService, WorkSchedule, answerSql, clientMessageSql } from '../analytics/control.service';
import { CLOSING_STAGE_KINDS } from '../deal_stage/stage-kind';
import { loadStaffUser } from '../bot/bot-access';
import { Access } from '../auth/access';
import { AI2, PROMPT_VERSION_2, crmBase, dayStart, isWorkingDay, localDay, minuteOfDay } from './ai-insights.config';
import { BotChat, InsightsNotifier } from './insights-common';
import { DIGEST_SYSTEM, DigestManager, DigestNumbers, cleanDigest, digestPrompt } from './insights-prompts';

const CHANNELS: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', email: 'почта', sms: 'SMS', calls: 'звонки', other: 'другое' };
const EVENT_CHANNEL: Record<number, string> = { 9: 'почта', 11: 'SMS', 12: 'Telegram', 16: 'WhatsApp' };
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Working seconds in words: «40 мин», «3 ч 10 мин», «2 дн 3 ч». */
export function waitText(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ''}`;
  return `${Math.floor(hours / 24)} дн${hours % 24 ? ` ${hours % 24} ч` : ''}`;
}

const money = (n: number) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const ddmm = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;

/**
 * The digests of the CRM bot (only to employees who linked it; working days only, CONTROL_WORK_DAYS):
 *  - morning, AI_DIGEST_MORNING at AI_DIGEST_MORNING_AT (08:30), to everybody who linked the bot: the clients
 *    waiting for this employee's answer (the deals where they are responsible, the client wrote last), the
 *    promises due today (found by the turn analysis), the overdue tasks. No AI call; nothing to say — no message.
 *  - evening, AI_DIGEST_EVENING at AI_DIGEST_EVENING_AT (18:30), to the admins and managers: the day's numbers of
 *    «Контроль менеджеров» (new deals, answers in time, late answers, calls) and the won / lost deals, with five
 *    lines «что важно» the AI writes from the numbers (one background call a day, job "digest"); when the AI is
 *    paused or out of budget the digest goes without them after AI_DIGEST_EVENING_WAIT_MIN.
 * Each once per employee and day (ai_notice), within AI_DIGEST_WINDOW_MIN after its time.
 */
@Injectable()
export class AiDigestService implements OnModuleInit {
  private readonly logger = new Logger('AiDigest');
  private morningOn = '';
  private eveningOn = '';

  constructor(
    private dataSource: DataSource,
    private queue: AiQueueService,
    private notifier: InsightsNotifier,
    private control: ControlService,
  ) {}

  onModuleInit(): void {
    this.queue.register('digest', (job) => this.run(job));
    this.queue.addTicker('digests', () => this.tick());
  }

  async tick(now = new Date()): Promise<number> {
    if ((!AI2.digestMorning && !AI2.digestEvening) || !this.notifier.enabled || !isWorkingDay(now)) return 0;
    const today = localDay(now);
    const minute = minuteOfDay(now);
    let sent = 0;
    if (AI2.digestMorning && this.morningOn !== today && minute >= AI2.morningAt && minute < AI2.morningAt + AI2.digestWindowMin) {
      sent += await this.morning(now);
      this.morningOn = today;
    }
    if (AI2.digestEvening && this.eveningOn !== today && minute >= AI2.eveningAt && minute < AI2.eveningAt + AI2.digestWindowMin) {
      const evening = await this.evening(now);
      if (evening.done) this.eveningOn = today;
      sent += evening.sent;
    }
    return sent;
  }

  // ------------------------------------------------------------------ morning

  /** The morning digest to everybody who linked the bot (or these employees); the number sent now. */
  async morning(now = new Date(), userIds?: number[]): Promise<number> {
    const day = localDay(now);
    let sent = 0;
    for (const chat of await this.notifier.chats(userIds ? { userIds } : {})) {
      try {
        const text = await this.morningText(chat, now);
        if (text && (await this.notifier.sendOnce('morning', chat, day, text))) sent++;
      } catch (error) {
        this.logger.warn(`morning digest for user ${chat.user_id}: ${(error as Error).message}`);
      }
    }
    if (sent) this.logger.log(`morning digest: ${sent} sent`);
    return sent;
  }

  /** The morning text of one employee; null when there is nothing to say. */
  async morningText(chat: BotChat, now = new Date()): Promise<string | null> {
    const user = await loadStaffUser(this.dataSource, chat.user_id);
    if (!user) return null;
    const withMail = new Access(user).canReadMail;
    const schedule = new WorkSchedule();
    const today = dayStart(localDay(now));
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const waitingDays = Math.max(1, Math.min(365, Number(process.env.CONTROL_WAITING_DAYS || 30)));

    const waiting: { id: number; display_id: number; label: string; asked_at: Date; type: number }[] = await this.dataSource.query(
      `SELECT d.id, d.display_id, d.label, q.created_at AS asked_at, q.type
         FROM deal d
         LEFT JOIN deal_stage s ON s.id = d.stage_id
         JOIN LATERAL (
           SELECT e.id, e.type, e.created_at FROM event e
            WHERE e.deal_id = d.id AND ${clientMessageSql('e', '$2')}
              AND e.created_at > COALESCE((SELECT MAX(o.created_at) FROM event o WHERE o.deal_id = d.id AND ${answerSql('o', '$3')}), '-infinity')
            ORDER BY e.created_at, e.id LIMIT 1
         ) q ON TRUE
        WHERE d.deleted_at IS NULL AND d.closed_at IS NULL AND d.agent_id = $1 AND NOT (COALESCE(s.kind, '') = ANY($4))
          AND q.created_at > now() - make_interval(days => $5::int)
        ORDER BY q.created_at, d.id LIMIT 30`,
      [chat.user_id, CHAT_TYPES, ANSWER_TYPES, CLOSING_STAGE_KINDS, waitingDays],
    );
    const promises: { text: string; due_at: Date; due_has_time: boolean; has_email: boolean; id: number; display_id: number }[] = AI.turns
      ? await this.dataSource.query(
          `SELECT i.text, i.due_at, i.due_has_time, i.has_email, d.id, d.display_id
             FROM conversation_item i JOIN deal d ON d.id = i.deal_id AND d.deleted_at IS NULL AND d.closed_at IS NULL
            WHERE i.kind = 'promise' AND i.who = 'manager' AND i.status = 'open' AND d.agent_id = $1
              AND i.due_at >= $2::timestamp - interval '7 days' AND i.due_at < $3
            ORDER BY i.due_at, i.id LIMIT 10`,
          [chat.user_id, today, tomorrow],
        )
      : [];
    const [{ overdue_n }] = await this.dataSource.query(
      `SELECT count(*)::int AS overdue_n FROM task t LEFT JOIN deal d ON d.id = t.deal_id
        WHERE t.closed_at IS NULL AND t.agent_id = $1 AND t.end_time < $2 AND (d.id IS NULL OR d.deleted_at IS NULL)`,
      [chat.user_id, now],
    );
    const overdue: { label: string; end_time: Date; display_id: number | null }[] = Number(overdue_n)
      ? await this.dataSource.query(
          `SELECT t.label, t.end_time, d.display_id FROM task t LEFT JOIN deal d ON d.id = t.deal_id
            WHERE t.closed_at IS NULL AND t.agent_id = $1 AND t.end_time < $2 AND (d.id IS NULL OR d.deleted_at IS NULL)
            ORDER BY t.end_time, t.id LIMIT 6`,
          [chat.user_id, now],
        )
      : [];
    if (!waiting.length && !promises.length && !Number(overdue_n)) return null;

    const lines = [`Доброе утро, ${chat.username}! Что важно сегодня:`];
    if (waiting.length) {
      lines.push('', `⏳ Ждут вашего ответа: ${waiting.length}`);
      for (const w of waiting.slice(0, 8)) {
        const waited = Math.max(schedule.seconds(new Date(w.asked_at), now), 60);
        lines.push(`• №${w.display_id} «${w.label}» — ${waitText(waited)} (${EVENT_CHANNEL[Number(w.type)] ?? 'чат'})`);
      }
      if (waiting.length > 8) lines.push(`…и ещё ${waiting.length - 8}`);
    }
    if (promises.length) {
      lines.push('', `🤝 Вы обещали клиентам: ${promises.length}`);
      for (const p of promises) {
        const due = new Date(p.due_at);
        const when = due < today ? `срок был ${ddmm(due)}` : p.due_has_time ? `до ${hhmm(due)}` : 'сегодня';
        lines.push(`• №${p.display_id}: ${p.has_email && !withMail ? 'обещание из письма' : p.text} — ${when}`);
      }
    }
    if (Number(overdue_n)) {
      lines.push('', `⚠️ Просроченные задачи: ${overdue_n}`);
      for (const t of overdue) lines.push(`• ${ddmm(new Date(t.end_time))} — ${t.label}${t.display_id ? ` (№${t.display_id})` : ''}`);
      if (Number(overdue_n) > overdue.length) lines.push(`…и ещё ${Number(overdue_n) - overdue.length}`);
    }
    const base = crmBase();
    if (base) lines.push('', `Задачи: ${base}/tasks`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ evening

  /** The day's numbers: «Контроль менеджеров» of today and the won / lost deals. */
  async dayNumbers(now = new Date()): Promise<{ numbers: DigestNumbers; managers: DigestManager[] }> {
    const day = localDay(now);
    const from = dayStart(day);
    const sla = Math.max(1, Number(process.env.CONTROL_SLA_MINUTES || 15));
    const report: any = await this.control.report({ from, till: now, slaMinutes: sla, waitingHours: 2 });
    const closed: { kind: string; agent_id: number | null; reason: string | null; n: number; amount: number }[] = await this.dataSource.query(
      `SELECT s.kind, d.agent_id, d.lost_reason AS reason, count(*)::int AS n, COALESCE(sum(d.budget), 0)::float AS amount
         FROM deal d JOIN deal_stage s ON s.id = d.stage_id
        WHERE d.deleted_at IS NULL AND s.kind IN ('won', 'lost') AND d.closed_at >= $1 AND d.closed_at < $2
        GROUP BY s.kind, d.agent_id, d.lost_reason`,
      [from, now],
    );
    const won = closed.filter((c) => c.kind === 'won');
    const lost = closed.filter((c) => c.kind === 'lost');
    const lostReasons: Record<string, number> = {};
    for (const l of lost) lostReasons[l.reason || 'не указана'] = (lostReasons[l.reason || 'не указана'] ?? 0) + Number(l.n);
    const summary = report.summary ?? {};
    const numbers: DigestNumbers = {
      day,
      new_deals: Number(summary.new_deals ?? 0),
      by_channel: summary.by_channel ?? {},
      in_sla_share: summary.in_sla_share ?? null,
      late: Number(summary.late ?? 0),
      sla_minutes: sla,
      waiting_now: Number(summary.waiting_now ?? 0),
      first_response_median_min: summary.first_response_median_sec === null || summary.first_response_median_sec === undefined ? null : Math.round(summary.first_response_median_sec / 60),
      calls: Number(summary.calls ?? 0),
      won: won.reduce((s, w) => s + Number(w.n), 0),
      won_amount: won.reduce((s, w) => s + Number(w.amount), 0),
      lost: lost.reduce((s, l) => s + Number(l.n), 0),
      lost_reasons: lostReasons,
    };
    const managers: DigestManager[] = (report.agents ?? [])
      .filter((a: any) => a.id && (a.leads || a.turns || a.calls))
      .slice(0, 20)
      .map((a: any) => ({
        name: a.name,
        new_deals: Number(a.leads ?? 0),
        turns: Number(a.turns ?? 0),
        answered: Number(a.answered ?? 0),
        late: Number(a.late ?? 0),
        unanswered: Number(a.unanswered ?? 0),
        calls: Number(a.calls ?? 0),
        in_sla_share: a.in_sla_share ?? null,
        won: won.filter((w) => Number(w.agent_id) === Number(a.id)).reduce((s, w) => s + Number(w.n), 0),
      }));
    return { numbers, managers };
  }

  private static dayKey(day: string): number {
    return Number(day.replace(/-/g, ''));
  }

  /** The AI job of the day's lines (one a day), made now with the numbers of this moment when there is none. */
  async dayJob(now = new Date()): Promise<AiJobRow> {
    const day = localDay(now);
    const [existing] = await this.dataSource.query(
      `SELECT * FROM ai_job WHERE kind = 'digest' AND entity = 'day' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [AiDigestService.dayKey(day)],
    );
    if (existing) return existing;
    const { numbers, managers } = await this.dayNumbers(now);
    const { job } = await this.queue.enqueue({
      kind: 'digest',
      entity: 'day',
      entityId: AiDigestService.dayKey(day),
      inputHash: sha256({ v: PROMPT_VERSION_2.digest, day }),
      input: { day, numbers, managers },
      priority: AiPriority.EVENT,
      promptVersion: PROMPT_VERSION_2.digest,
    });
    return job;
  }

  /**
   * The evening digest to the admins and managers who linked the bot (or these employees): sent when the AI's lines
   * are ready or AI_DIGEST_EVENING_WAIT_MIN passed (`waitMs`: a run by hand waits for them that long at most).
   */
  async evening(now = new Date(), opts: { userIds?: number[]; waitMs?: number } = {}): Promise<{ done: boolean; sent: number; job_id: number | null }> {
    let job = await this.dayJob(now);
    if (opts.waitMs && ['queued', 'running'].includes(job.status)) job = (await this.queue.wait(job.id, opts.waitMs)) ?? job;
    const finished = ['done', 'failed', 'skipped'].includes(job.status);
    const waited = Date.now() - new Date(job.created_at).getTime();
    if (!finished && !opts.waitMs && waited < AI2.eveningWaitMin * 60_000) return { done: false, sent: 0, job_id: job.id };
    let note: string | null = null;
    if (!finished) {
      const pause = await this.queue.pause();
      note = pause ? 'ИИ на паузе (лимит подписки)' : (await this.queue.backgroundCallsToday()) >= AI.dailyBudget ? 'дневной лимит ИИ исчерпан' : 'ИИ не успел';
      // the lines are not needed any more: the job does not run tomorrow
      await this.dataSource.query(
        `UPDATE ai_job SET status = 'skipped', error = 'дайджест ушёл без строк ИИ', finished_at = now() WHERE id = $1 AND status = 'queued'`,
        [job.id],
      );
    } else if (job.status !== 'done') {
      note = 'ИИ не смог разобрать цифры';
    }
    const lines: string[] = job.status === 'done' && Array.isArray(job.result?.lines) ? job.result.lines : [];
    const text = this.eveningText(job.input?.numbers as DigestNumbers, lines, note);
    const day = localDay(now);
    let sent = 0;
    for (const chat of await this.notifier.chats({ roles: ['admin', 'manager'], ...(opts.userIds ? { userIds: opts.userIds } : {}) })) {
      if (await this.notifier.sendOnce('evening', chat, day, text)) sent++;
    }
    if (sent) this.logger.log(`evening digest: ${sent} sent${note ? ` (${note})` : ''}`);
    return { done: true, sent, job_id: job.id };
  }

  eveningText(numbers: DigestNumbers, lines: string[], note: string | null): string {
    const day = dayStart(numbers.day);
    const out = [`📊 Итоги дня, ${ddmm(day)} (${WEEKDAYS[day.getDay()]})`];
    const channels = Object.entries(numbers.by_channel ?? {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([key, n]) => `${CHANNELS[key] ?? key} ${n}`)
      .join(' · ');
    out.push(`Новых сделок: ${numbers.new_deals}${channels ? ` — ${channels}` : ''}`);
    out.push(
      numbers.in_sla_share === null
        ? 'Ответов клиентам с нормативом пока нет'
        : `Ответы в норматив ${numbers.sla_minutes} мин: ${numbers.in_sla_share}%, поздно или без ответа: ${numbers.late}`,
    );
    if (numbers.first_response_median_min !== null) out.push(`Первый ответ новому клиенту: обычно ${numbers.first_response_median_min} мин`);
    out.push(`Ждут ответа сейчас: ${numbers.waiting_now}`);
    out.push(`Звонков: ${numbers.calls}`);
    const reasons = Object.entries(numbers.lost_reasons ?? {})
      .map(([r, n]) => `${r} ${n}`)
      .join(', ');
    out.push(`Выиграно: ${numbers.won}${numbers.won ? ` на ${money(numbers.won_amount)}` : ''} · проиграно: ${numbers.lost}${reasons ? ` (${reasons})` : ''}`);
    if (lines.length) {
      out.push('', 'Что важно (ИИ):');
      for (const line of lines) out.push(`• ${line}`);
    } else if (note) {
      out.push('', `Разбор ИИ не готов: ${note}.`);
    }
    const base = crmBase();
    if (base) out.push('', `Контроль менеджеров: ${base}/analytics/control`);
    return out.join('\n');
  }

  private async run(job: AiJobRow): Promise<AiOutcome> {
    const numbers = job.input?.numbers as DigestNumbers | undefined;
    if (!numbers) return { skipped: 'нет цифр дня' };
    if (numbers.day !== localDay(new Date())) return { skipped: 'день уже прошёл' };
    const managers: DigestManager[] = Array.isArray(job.input?.managers) ? job.input.managers : [];
    const raw = await this.queue.askJson(job, DIGEST_SYSTEM, digestPrompt({ now: new Date(), numbers, managers }));
    if (!Array.isArray(raw.lines)) throw new AiFormatError('ИИ ответил не по формату дайджеста');
    return { result: { lines: cleanDigest(raw) } };
  }
}
