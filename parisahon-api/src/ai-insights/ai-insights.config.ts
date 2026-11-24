import { AI } from '../ai/ai.config';
import { WorkSchedule } from '../analytics/control.service';

/**
 * Switches of the AI features built on the AI core (src/ai): «Сравнение с рынком», «Разбор нового обращения»,
 * the morning and evening digests in the bot, «Причина проигрыша» and «ИИ-супервайзер». Read from the
 * environment on every use; nothing works without AI_FEATURES=1 (the core's main switch). The features that
 * only show something are on with it (AI_MARKET, AI_LOST_REASON); every feature that writes into a deal or
 * sends a message is off until switched on (see parisahon-api/.env.example). Nothing here ever writes to a
 * client or makes a task. Every AI call goes through the core's queue: the background ones count against
 * AI_DAILY_BUDGET, a person's ones are limited per hour (AI_INTERACTIVE_PER_HOUR), all of them wait during the
 * pause after the subscription's usage limit.
 *
 *   AI_MARKET=1             «Рынок»: the client's words about other suppliers (price, MOQ, delivery, quality, payment,
 *                           the supplier or country) are taken out of the turns the core analysed with the flags
 *                           competitor / price_objection / discount or a target price (one background call per such turn,
 *                           turns of the last AI_MARKET_DAYS); the page Аналитика → Рынок and its AI summary on demand.
 *   AI_INBOUND=0            the first message / letter of a new contact is classified (заявка, клиент, поставщик,
 *                           личное, спам, другое; country, client type, language, «что хочет клиент»), stored in
 *                           deal_inbound, noted in the deal history (AI_INBOUND_NOTE=1) and told to the responsible
 *                           manager in the bot (AI_INBOUND_NOTIFY=1). Nothing is deleted or moved: «не заявки» go
 *                           to the list «Новые обращения» of the control page.
 *   AI_DIGEST_MORNING=0     at AI_DIGEST_MORNING_AT (08:30) to every employee who linked the bot: clients waiting
 *                           for an answer, promises due today, overdue tasks. No AI call.
 *   AI_DIGEST_EVENING=0     at AI_DIGEST_EVENING_AT (18:30) to the admins and managers who linked the bot: the day's
 *                           numbers and five lines «что важно» by the AI (one call a day; without them after
 *                           AI_DIGEST_EVENING_WAIT_MIN when the AI is paused or out of budget).
 *                           Both digests on working days only (CONTROL_WORK_DAYS), within AI_DIGEST_WINDOW_MIN.
 *   AI_LOST_REASON=1        «Причина проигрыша»: the reason form of a lost deal asks the AI for a reason with a
 *                           quote (a person waits: AI_INTERACTIVE_PER_HOUR); the manager confirms it.
 *   AI_SUPERVISOR=0         at night (AI_SUPERVISOR_AT .. 07:00) every dialog of a past day (a deal with messages of
 *                           the client and of the manager that day) is reviewed against the checklist; at most
 *                           AI_SUPERVISOR_MAX dialogs a night (background calls: AI_DAILY_BUDGET counts them too).
 *                           Advisory only: shown in «Качество диалогов», never part of any rating.
 *   AI_SUPERVISOR_TIPS=1    with the supervisor on: once a week (AI_SUPERVISOR_TIPS_DAY, 1 = Monday, at
 *                           AI_SUPERVISOR_TIPS_AT) each employee who linked the bot gets «3 ошибки и как сказать лучше».
 *   AI_INSIGHTS_TEST_PREFIX test stands only: the background detectors of these features look only at deals named so
 *                           (default there: AI_TEST_DEAL_PREFIX + "i2-"; empty in production).
 */
function flag(name: string, fallback: boolean): boolean {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return !['0', 'false', 'off', 'no'].includes(value);
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? '').trim();
  const value = raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** "08:30" -> minutes of the day (the fallback when it is not a time). */
function clock(name: string, fallback: string): number {
  const raw = (process.env[name] || fallback).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback);
  const h = Math.min(23, Number(m![1]));
  const mi = Math.min(59, Number(m![2]));
  return h * 60 + mi;
}

export const AI2 = {
  // ------------------------------------------------------------------ «Рынок»
  get market(): boolean {
    return AI.enabled && flag('AI_MARKET', true);
  },
  /** turns of the last N days are read for the market (never beyond the life of the AI jobs: a job is the mark) */
  get marketDays(): number {
    return Math.min(num('AI_MARKET_DAYS', 60, 1, 365), Math.max(1, AI.keepDays - 1));
  },
  /** the currency of the CRM's prices (deal products, the price list) */
  get marketCurrency(): string {
    return (process.env.AI_MARKET_CURRENCY || 'UZS').trim().toUpperCase().slice(0, 8) || 'UZS';
  },
  /** "USD=12800,EUR=13900": prices in these currencies are compared with ours in AI_MARKET_CURRENCY (none: not compared) */
  get marketRates(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const part of (process.env.AI_MARKET_RATES || '').split(',')) {
      const [code, value] = part.split('=').map((s) => s.trim());
      const rate = Number(value);
      if (/^[A-Za-z]{3}$/.test(code ?? '') && Number.isFinite(rate) && rate > 0) out[code.toUpperCase()] = rate;
    }
    return out;
  },

  // ------------------------------------------------------------------ «Разбор нового обращения»
  get inbound(): boolean {
    return AI.enabled && flag('AI_INBOUND', false);
  },
  get inboundNotify(): boolean {
    return this.inbound && flag('AI_INBOUND_NOTIFY', true);
  },
  get inboundNote(): boolean {
    return this.inbound && flag('AI_INBOUND_NOTE', true);
  },
  /** deals created within the last N hours are looked at (older ones are not «new» any more) */
  get inboundHours(): number {
    return num('AI_INBOUND_HOURS', 24, 1, 168);
  },
  /** minutes after the first message before it is read, unless the manager answered (the client may write in parts) */
  get inboundWaitMin(): number {
    return num('AI_INBOUND_WAIT_MIN', 3, 0, 120);
  },

  // ------------------------------------------------------------------ digests
  get digestMorning(): boolean {
    return AI.enabled && flag('AI_DIGEST_MORNING', false);
  },
  get digestEvening(): boolean {
    return AI.enabled && flag('AI_DIGEST_EVENING', false);
  },
  get morningAt(): number {
    return clock('AI_DIGEST_MORNING_AT', '08:30');
  },
  get eveningAt(): number {
    return clock('AI_DIGEST_EVENING_AT', '18:30');
  },
  /** a digest is sent within this many minutes after its time (an API started later the same morning still sends it) */
  get digestWindowMin(): number {
    return num('AI_DIGEST_WINDOW_MIN', 180, 10, 720);
  },
  /** the evening digest waits this long for the AI's lines, then goes with the numbers alone */
  get eveningWaitMin(): number {
    return num('AI_DIGEST_EVENING_WAIT_MIN', 20, 0, 180);
  },

  // ------------------------------------------------------------------ «Причина проигрыша»
  get lostReason(): boolean {
    return AI.enabled && flag('AI_LOST_REASON', true);
  },
  /** how long the reason form waits for the AI's proposal (then it polls) */
  get lostWaitSec(): number {
    return num('AI_LOST_WAIT_SEC', 25, 1, 120);
  },

  // ------------------------------------------------------------------ «ИИ-супервайзер»
  get supervisor(): boolean {
    return AI.enabled && flag('AI_SUPERVISOR', false);
  },
  /** the night pass starts at this time and stops at 07:00 */
  get supervisorAt(): number {
    return clock('AI_SUPERVISOR_AT', '01:00');
  },
  /** dialogs reviewed per night at most */
  get supervisorMax(): number {
    return num('AI_SUPERVISOR_MAX', 40, 0, 2000);
  },
  /** past days looked at (a night missed is caught up) */
  get supervisorDays(): number {
    return num('AI_SUPERVISOR_DAYS', 3, 1, 14);
  },
  get tips(): boolean {
    return this.supervisor && flag('AI_SUPERVISOR_TIPS', true);
  },
  /** 1 Monday ... 7 Sunday */
  get tipsDay(): number {
    return num('AI_SUPERVISOR_TIPS_DAY', 1, 1, 7);
  },
  get tipsAt(): number {
    return clock('AI_SUPERVISOR_TIPS_AT', '09:30');
  },

  /**
   * Test stands only: the background detectors of these features look only at deals whose name starts with this.
   * Not set: the core's AI_TEST_DEAL_PREFIX + "i2-" on a test stand (AUDIT-ai-i2-…: the deals of the core's own
   * checks are left alone), nothing in production (every deal).
   */
  get testPrefix(): string {
    const own = (process.env.AI_INSIGHTS_TEST_PREFIX || '').trim();
    if (own) return own;
    return AI.testDealPrefix ? `${AI.testDealPrefix}i2-` : '';
  },

  features(): Record<string, boolean> {
    return {
      enabled: AI.enabled,
      market: this.market,
      inbound: this.inbound,
      inbound_notify: this.inboundNotify,
      inbound_note: this.inboundNote,
      digest_morning: this.digestMorning,
      digest_evening: this.digestEvening,
      lost_reason: this.lostReason,
      supervisor: this.supervisor,
      supervisor_tips: this.tips,
    };
  },
};

/** Prompt versions of these features: a new version is a new input (cache and dedupe key). */
export const PROMPT_VERSION_2 = {
  inbound: 'inbound-1',
  review: 'review-1',
  digest: 'digest-1',
  lost: 'lost-1',
  market: 'market-1',
  marketSummary: 'market-summary-1',
};

/** Minutes since local midnight. */
export function minuteOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** 1 Monday ... 7 Sunday */
export function weekday(now: Date): number {
  return now.getDay() === 0 ? 7 : now.getDay();
}

/** Is `now` a working day (CONTROL_WORK_DAYS, 1 Monday ... 7 Sunday)? */
export function isWorkingDay(now: Date, schedule = new WorkSchedule()): boolean {
  return schedule.days.has(weekday(now));
}

/** "YYYY-MM-DD" of a local date. */
export function localDay(value: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
}

/** Local midnight of a "YYYY-MM-DD". */
export function dayStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** A text for LIKE: its own %, _ and \ match only themselves. */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The CRM address for links in bot messages ('' when CRM_PUBLIC_URL is not set). */
export function crmBase(): string {
  return (process.env.CRM_PUBLIC_URL || '').replace(/\/+$/, '');
}

/**
 * SQL condition (positional parameters pushed to `params`) of the test-stand prefix on the deal `alias`:
 * '' when AI_INSIGHTS_TEST_PREFIX is not set (production: every deal).
 */
export function testPrefixSql(params: unknown[], alias = 'd'): string {
  const prefix = AI2.testPrefix;
  if (!prefix) return '';
  params.push(`${likeEscape(prefix)}%`);
  return `AND ${alias}.label LIKE $${params.length}`;
}
