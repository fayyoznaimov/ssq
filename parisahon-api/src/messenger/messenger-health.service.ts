import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TelegramBotApi } from '../bot/telegram-bot.api';
import { RoleEnum } from '../user/user.entity';
import {
  callService,
  telegramServiceConfigured,
  telegramServiceHeaders,
  telegramServiceUrl,
  whatsappServiceConfigured,
  whatsappServiceHeaders,
  whatsappServiceUrl,
} from './messenger-services';
import { Channel } from './messenger-filter.service';

/** A session as the service reports it (GET /get-sessions, GET /sessions). */
export interface ServiceSession {
  user_id: number;
  status: string;
  error?: string | null;
  since?: string | number | null;
  phone?: string | null;
  name?: string | null;
  username?: string | null;
  tg_id?: number | string | null;
  reconnects?: number;
  linked?: boolean;
  last_message_at?: string | number | null;
}

/** What a manager sees about one messenger: ok / connecting / broken / off, and why. */
export interface SessionHealth {
  channel: Channel;
  status: string;
  state: 'ok' | 'connecting' | 'broken' | 'off' | 'unknown';
  text: string;
  since: string | null;
  phone?: string | null;
  error?: string | null;
}

const STAFF = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];
const LONG_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

function sinceMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  // the Telegram service gives seconds since the epoch, the WhatsApp one an ISO string
  const t = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Whether the managers' own Telegram and WhatsApp still feed the CRM (TG-1, WA-1, TG-14, WA-10):
 *  - describe(): the state of a session in words, for the pages and the deal composer;
 *  - every MESSENGER_HEALTH_SEC (300; 0 = off) both services are asked for their sessions: a session that
 *    broke (Telegram signed out in the phone, WhatsApp unlinked, reconnecting longer than 10 minutes)
 *    gets its manager a message from the CRM bot, again once a day while it stays broken, and one when it
 *    works again (table messenger_account keeps what was told);
 *  - a session of a staff user who was deleted (the CRM still has the row) is
 *    disconnected from the CRM at once, and the admins are told.
 * The server watchdog (deploy/prod/ops/watchdog.py) tells the admins about the same states.
 */
@Injectable()
export class MessengerHealthService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MessengerHealthService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private bot: TelegramBotApi | null = null;

  constructor(private dataSource: DataSource) {}

  onApplicationBootstrap() {
    const every = Number(process.env.MESSENGER_HEALTH_SEC ?? 300);
    if (!Number.isFinite(every) || every <= 0) return;
    this.timer = setInterval(() => void this.tick(), Math.max(60, every) * 1000);
    this.timer.unref?.();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ states

  async telegramSessions(timeoutMs = 10_000): Promise<ServiceSession[] | null> {
    if (!telegramServiceConfigured()) return null;
    try {
      const { status, payload } = await callService(`${telegramServiceUrl()}/get-sessions`, 'GET', telegramServiceHeaders(), undefined, timeoutMs);
      return status === 200 && Array.isArray(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  async whatsappSessions(timeoutMs = 10_000): Promise<ServiceSession[] | null> {
    if (!whatsappServiceConfigured()) return null;
    try {
      const { status, payload } = await callService(`${whatsappServiceUrl()}/sessions`, 'GET', whatsappServiceHeaders(), undefined, timeoutMs);
      return status === 200 && Array.isArray(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  /** The state of a session in the manager's words. `session` null = the service has none for the user. */
  static describe(channel: Channel, session: ServiceSession | null | undefined, reachable = true): SessionHealth {
    const since = sinceMs(session?.since);
    const out = (state: SessionHealth['state'], text: string): SessionHealth => ({
      channel,
      status: session?.status ?? (reachable ? 'none' : 'unknown'),
      state,
      text,
      since: since ? new Date(since).toISOString() : null,
      phone: session?.phone ?? null,
      error: session?.error ?? null,
    });
    const name = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
    if (!reachable) return out('unknown', `${name}-сервис не отвечает`);
    const long = since !== null && Date.now() - since >= LONG_MS;
    const when = since ? ` с ${new Date(since).toLocaleString('ru-RU', { timeZone: process.env.TZ || 'Asia/Karachi', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
    switch (session?.status ?? 'none') {
      case 'connected':
        return out('ok', `${name} подключён${session?.phone ? `: ${session.phone}` : ''}`);
      case 'starting':
        if (channel === 'whatsapp' && session?.linked) {
          const attempt = session.reconnects ? `, попытка ${session.reconnects}` : '';
          return out(long ? 'broken' : 'connecting', `${name} переподключается${when}${attempt}: сообщения пока не приходят`);
        }
        return out('connecting', `${name} подключается…`);
      case 'qr':
      case 'code':
        return out('connecting', `${name}: ждём привязку на телефоне`);
      case 'error':
        return out(long ? 'broken' : 'connecting', `${name}: нет связи${when}${session?.error ? ` (${session.error})` : ''}, сервис пробует снова`);
      case 'revoked':
        return out('broken', `${name} отключён в самом Telegram (сеанс завершён${when}): сообщения клиентов не приходят. Подключите заново`);
      case 'logged_out':
        return out('broken', `${name} отвязан на телефоне${when}: сообщения клиентов не приходят. Подключите заново`);
      case 'stopped':
        return out('off', `${name} отключён от CRM`);
      default:
        return out('off', `${name} не подключён`);
    }
  }

  /** Both messengers of a user, for the pages and the deal composer (never fails: 'unknown' instead). */
  async statusOf(userId: number): Promise<{ telegram: SessionHealth; whatsapp: SessionHealth }> {
    const [tg, wa] = await Promise.all([this.telegramSessions(2500), this.whatsappSessions(2500)]);
    const pick = (list: ServiceSession[] | null) => list?.find((s) => Number(s.user_id) === userId) ?? null;
    return {
      telegram: telegramServiceConfigured()
        ? MessengerHealthService.describe('telegram', pick(tg), tg !== null)
        : { channel: 'telegram', status: 'none', state: 'off', text: 'Telegram-сервис не подключён к этой копии CRM', since: null },
      whatsapp: whatsappServiceConfigured()
        ? MessengerHealthService.describe('whatsapp', pick(wa), wa !== null)
        : { channel: 'whatsapp', status: 'none', state: 'off', text: 'WhatsApp-сервис не подключён к этой копии CRM', since: null },
    };
  }

  // ------------------------------------------------------------------ the job

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [tg, wa] = await Promise.all([this.telegramSessions(), this.whatsappSessions()]);
      const people = await this.people([...(tg ?? []), ...(wa ?? [])].map((s) => Number(s.user_id)));
      if (tg) await this.observeAll('telegram', tg, people);
      if (wa) await this.observeAll('whatsapp', wa, people);
    } catch (error) {
      this.logger.warn(`messenger health: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async observeAll(channel: Channel, sessions: ServiceSession[], people: Map<number, 'staff' | 'former'>): Promise<void> {
    for (const session of sessions) {
      const userId = Number(session.user_id);
      if (!Number.isInteger(userId) || userId <= 0) continue;
      const who = people.get(userId);
      // a user id this database does not know at all (another copy of the CRM?): never touched
      if (!who) continue;
      if (who === 'former') {
        if (!['none', 'stopped'].includes(String(session.status))) await this.disconnectFormer(channel, userId);
        continue;
      }
      await this.observe(channel, userId, MessengerHealthService.describe(channel, session));
    }
  }

  /** Remembers the state; tells the manager when it broke (once a day while broken) and when it is fixed. */
  async observe(channel: Channel, userId: number, health: SessionHealth): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT status, notified_status, notified_at FROM messenger_account WHERE user_id = $1 AND channel = $2`,
      [userId, channel],
    );
    const row = rows[0];
    if (!row || row.status !== health.status) {
      await this.dataSource.query(
        `INSERT INTO messenger_account (user_id, channel, status, detail, status_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, channel) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, status_at = now()`,
        [userId, channel, health.status, (health.error ?? '').slice(0, 500) || null],
      );
    }
    const name = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
    const where = channel === 'telegram' ? 'CRM → Телеграм → Подключить' : 'CRM → WhatsApp (или Профиль) → Подключить';
    const notifiedAt = row?.notified_at ? new Date(row.notified_at).getTime() : 0;
    if (health.state === 'broken' && (row?.notified_status !== 'broken' || Date.now() - notifiedAt > DAY_MS)) {
      const sent = await this.tell(userId, `⚠️ ${health.text}.\nПока это так, переписка с клиентами из вашего ${name} не попадает в CRM. Подключить: ${where}.`);
      await this.markNotified(userId, channel, sent ? 'broken' : row?.notified_status ?? null, sent);
    } else if (health.state === 'ok' && row?.notified_status === 'broken') {
      const sent = await this.tell(userId, `✅ ${name} снова подключён к CRM: переписка с клиентами опять приходит в сделки.`);
      await this.markNotified(userId, channel, 'ok', sent);
    }
  }

  private async markNotified(userId: number, channel: Channel, status: string | null, sent: boolean): Promise<void> {
    await this.dataSource.query(
      `UPDATE messenger_account SET notified_status = $3, notified_at = CASE WHEN $4 THEN now() ELSE notified_at END
        WHERE user_id = $1 AND channel = $2`,
      [userId, channel, status, sent],
    );
  }

  /** A session of somebody who is not a staff user any more: off the CRM, the admins are told once. */
  private async disconnectFormer(channel: Channel, userId: number): Promise<void> {
    try {
      const ok = channel === 'telegram'
        ? (await callService(`${telegramServiceUrl()}/logout`, 'POST', telegramServiceHeaders(), { user_id: userId }, 30_000)).status < 400
        : (await callService(`${whatsappServiceUrl()}/sessions/${userId}`, 'DELETE', whatsappServiceHeaders(), undefined, 30_000)).status < 400;
      const name = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
      const who = (await this.dataSource.query(`SELECT username FROM "user" WHERE id = $1`, [userId]))[0]?.username ?? `№${userId}`;
      this.logger.warn(`${channel} session of user ${userId} (not a staff user any more): ${ok ? 'disconnected' : 'could not be disconnected'}`);
      if (ok) {
        await this.tellAdmins(`${name} сотрудника «${who}» отключён от CRM: его больше нет среди сотрудников. Переписку с его клиентами ведите со своего ${name}.`);
      }
    } catch (error) {
      this.logger.warn(`disconnect ${channel} of user ${userId}: ${(error as Error).message}`);
    }
  }

  /**
   * user id -> a staff user now, or 'former' (a staff user who was deleted). Ids the database does not know,
   * and ids of client contacts (a service that belongs to another copy of the CRM), are left out: never touched.
   */
  private async people(ids: number[]): Promise<Map<number, 'staff' | 'former'>> {
    const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (!unique.length) return new Map();
    const rows: { id: number; active: boolean }[] = await this.dataSource.query(
      `SELECT id, deleted_at IS NULL AS active FROM "user" WHERE id = ANY($1) AND role = ANY($2)`,
      [unique, STAFF],
    );
    return new Map(rows.map((r) => [Number(r.id), r.active ? 'staff' : 'former']));
  }

  // ------------------------------------------------------------------ the CRM bot

  private api(): TelegramBotApi | null {
    const token = (process.env.CRM_BOT_TOKEN || '').trim();
    if (!token) return null;
    if (!this.bot) this.bot = new TelegramBotApi(token, process.env.CRM_BOT_API_BASE || undefined);
    return this.bot;
  }

  /** A message from the CRM bot to the user, when they linked it. false when it could not be sent. */
  private async tell(userId: number, text: string): Promise<boolean> {
    const api = this.api();
    if (!api) return false;
    const rows = await this.dataSource.query(`SELECT chat_id FROM bot_account WHERE user_id = $1`, [userId]);
    if (!rows[0]) return false;
    try {
      await api.sendMessage(rows[0].chat_id, text);
      return true;
    } catch (error) {
      this.logger.warn(`bot message to user ${userId}: ${(error as Error).message}`);
      return false;
    }
  }

  private async tellAdmins(text: string): Promise<void> {
    const api = this.api();
    if (!api) return;
    const rows = await this.dataSource.query(
      `SELECT ba.chat_id FROM bot_account ba JOIN "user" u ON u.id = ba.user_id WHERE u.deleted_at IS NULL AND u.role = $1`,
      [RoleEnum.ADMIN],
    );
    for (const row of rows) {
      await api.sendMessage(row.chat_id, text).catch(() => undefined);
    }
  }
}
