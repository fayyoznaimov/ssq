import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Access } from '../auth/access';
import { AI } from '../ai/ai.config';
import { NotificationGateWay } from '../gateway/notification.gateway';
import { InlineKeyboard, TelegramBotApi } from '../bot/telegram-bot.api';
import { returnedRows } from '../ai/ai-queue.service';

/**
 * What the features of src/ai-insights share: the deal scope of a reader in raw SQL, the hourly limit of a
 * person's AI requests, the live update of the deal page and the messages to employees in the CRM bot.
 */

/**
 * SQL condition limiting deals (alias `alias`) to what the user may see (Access, the one rule of the CRM),
 * with positional parameters pushed to `params`.
 */
export function dealScopeSql(access: Access, params: unknown[], alias = 'd'): string {
  const scope = access.scope('deal', 'view');
  if (scope === 'all') return 'TRUE';
  if (scope === 'none') return 'FALSE';
  params.push(access.id);
  const me = `$${params.length}`;
  const group = access.user.group_id;
  if (scope === 'own' || group === null || group === undefined) return `${alias}.agent_id = ${me}`;
  params.push(group);
  return `(${alias}.agent_id = ${me} OR ${alias}.agent_id IN (SELECT sg.id FROM "user" sg WHERE sg.group_id = $${params.length}))`;
}

/** A person's AI requests that need a new CLI call: at most AI_INTERACTIVE_PER_HOUR per user and hour (per feature). */
export class HourlyLimit {
  private readonly perUser = new Map<number, number[]>();

  constructor(private readonly what: string) {}

  take(userId: number): void {
    const now = Date.now();
    const recent = (this.perUser.get(userId) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= AI.perUserHour) throw new BadRequestException(`Лимит запросов к ИИ (${this.what}) на этот час исчерпан, попробуйте позже`);
    recent.push(now);
    this.perUser.set(userId, recent);
  }
}

/** The deal page reloads its AI block (socket 'changed' {ai: [dealId]}: ids only, never data). */
export function liveAi(gateway: NotificationGateWay, dealId: number, logger?: Logger): void {
  try {
    gateway.server?.emit('changed', { ai: [dealId] });
  } catch (error) {
    logger?.warn(`live update: ${(error as Error).message}`);
  }
}

/** The country calling code of a phone ("+998 90 123-45-67" -> "+998"); nothing more of the number goes anywhere. */
export function phoneCode(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const known = ['998', '992', '993', '994', '996', '995', '374', '375', '380', '373', '971', '966', '974', '965', '880', '852', '886', '420', '421'];
  for (const code of known) if (digits.startsWith(code)) return `+${code}`;
  if (digits.startsWith('7')) return digits[1] === '6' || digits[1] === '7' ? '+7 (Казахстан)' : '+7';
  // two-digit codes (Turkey 90, China 86, India 91, Germany 49, ...), else one digit (USA 1)
  if (/^[2-9]\d/.test(digits)) return `+${digits.slice(0, 2)}`;
  return `+${digits[0]}`;
}

export interface BotChat {
  user_id: number;
  chat_id: string;
  role: string;
  username: string;
}

/**
 * Messages of the AI features to employees who linked the CRM bot (bot_account), straight through the Telegram
 * Bot API with the bot's token (CRM_BOT_TOKEN, CRM_BOT_API_BASE) — never to a client. Links to the CRM are in the text (CRM_PUBLIC_URL).
 * ai_notice marks what was sent once per kind, employee and day (claimed before sending: two API processes or a
 * restart never send twice).
 */
@Injectable()
export class InsightsNotifier {
  private readonly logger = new Logger('AiInsightsBot');
  private api: TelegramBotApi | null = null;
  private token = '';

  constructor(private dataSource: DataSource) {}

  get enabled(): boolean {
    return !!(process.env.CRM_BOT_TOKEN || '').trim();
  }

  private client(): TelegramBotApi | null {
    const token = (process.env.CRM_BOT_TOKEN || '').trim();
    if (!token) return null;
    if (!this.api || token !== this.token) {
      this.api = new TelegramBotApi(token, process.env.CRM_BOT_API_BASE || undefined);
      this.token = token;
    }
    return this.api;
  }

  /** The linked chats of staff users (only these ids / roles when given). */
  async chats(filter: { userIds?: number[]; roles?: string[] } = {}): Promise<BotChat[]> {
    if (!this.enabled) return [];
    const params: unknown[] = [];
    const where: string[] = [`u.deleted_at IS NULL`, `u.role IN ('admin', 'manager', 'agent')`];
    if (filter.userIds) {
      params.push(filter.userIds);
      where.push(`ba.user_id = ANY($${params.length})`);
    }
    if (filter.roles) {
      params.push(filter.roles);
      where.push(`u.role = ANY($${params.length})`);
    }
    const rows = await this.dataSource.query(
      `SELECT ba.user_id, ba.chat_id, u.role, u.username FROM bot_account ba JOIN "user" u ON u.id = ba.user_id
        WHERE ${where.join(' AND ')} ORDER BY ba.user_id`,
      params,
    );
    return rows.map((r: any) => ({ user_id: Number(r.user_id), chat_id: String(r.chat_id), role: r.role, username: r.username }));
  }

  /** Sends a text (cut into Telegram-sized parts); true when the bot accepted it. Never throws. */
  async send(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    const api = this.client();
    if (!api) return false;
    try {
      let rest = text;
      const parts: string[] = [];
      while (rest.length > 4000) {
        const cut = Math.max(rest.lastIndexOf('\n', 4000), 2000);
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
      }
      parts.push(rest);
      for (let i = 0; i < parts.length; i++) {
        await api.sendMessage(chatId, parts[i], i === parts.length - 1 && keyboard?.length ? keyboard : undefined);
      }
      return true;
    } catch (error) {
      this.logger.warn(`message to chat ${chatId} failed: ${(error as Error).message}`);
      return false;
    }
  }

  /** Claims «kind» for the employee and day; the id of the claim, null when it was claimed before. */
  async claim(kind: string, userId: number, day: string): Promise<number | null> {
    const rows = returnedRows(
      await this.dataSource.query(
        `INSERT INTO ai_notice (kind, user_id, day) VALUES ($1, $2, $3::date) ON CONFLICT (kind, user_id, day) DO NOTHING RETURNING id`,
        [kind, userId, day],
      ),
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  async delivered(id: number, ok: boolean): Promise<void> {
    await this.dataSource.query(`UPDATE ai_notice SET delivered = $2 WHERE id = $1`, [id, ok]);
  }

  /** Claims, sends, marks: true when sent now. */
  async sendOnce(kind: string, chat: BotChat, day: string, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    const claim = await this.claim(kind, chat.user_id, day);
    if (!claim) return false;
    const ok = await this.send(chat.chat_id, text, keyboard);
    await this.delivered(claim, ok);
    return ok;
  }
}
