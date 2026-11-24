import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { AiPriority } from '../ai/ai.config';
import { AiFormatError, AiJobRow, AiOutcome, AiQueueService, returnedRows, sha256 } from '../ai/ai-queue.service';
import { CHAT_EVENT_TYPES, ChatMessage, loadDeal, messagesByIds } from '../ai/ai-conversation';
import { Event, EventTypes } from '../events/event.entity';
import { EventBuilder } from '../events/event.builder';
import { EventWrapper } from '../events/event.wrapper';
import { Deal } from '../deal/deal.entity';
import { NotificationGateWay } from '../gateway/notification.gateway';
import { loadStaffUser } from '../bot/bot-access';
import { AI2, PROMPT_VERSION_2, crmBase, dayStart, testPrefixSql } from './ai-insights.config';
import { InsightsNotifier, dealScopeSql, liveAi, phoneCode } from './insights-common';
import {
  CLIENT_TYPES,
  INBOUND_CATEGORIES,
  INBOUND_SYSTEM,
  InboundContact,
  InboundReading,
  cleanInbound,
  inboundPrompt,
  looksLikeInbound,
} from './insights-prompts';

const CHANNEL_LABEL: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', email: 'письмо' };
const LANGUAGE_LABEL: Record<string, string> = {
  ru: 'русский', uz: 'узбекский', en: 'английский', kk: 'казахский', ky: 'киргизский', tg: 'таджикский', tk: 'туркменский',
  tr: 'турецкий', az: 'азербайджанский', zh: 'китайский', de: 'немецкий', ar: 'арабский', fa: 'персидский',
};
const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface InboundListQuery {
  from_date?: string;
  till_date?: string;
  /** all | lead | not_lead | one of the categories */
  category?: string;
  /** all | new | reviewed */
  status?: string;
  page?: number;
}

/** «Заявка · опт · Казахстан · язык: казахский» */
export function inboundLine(row: { category: string; client_type?: string | null; country?: string | null; language?: string | null }): string {
  return [
    INBOUND_CATEGORIES[row.category as keyof typeof INBOUND_CATEGORIES] ?? row.category,
    row.client_type ? CLIENT_TYPES[row.client_type as keyof typeof CLIENT_TYPES] ?? row.client_type : null,
    row.country || null,
    row.language && row.language !== 'ru' ? `язык: ${LANGUAGE_LABEL[row.language.split('-')[0]] ?? row.language}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * «Разбор нового обращения»: the first message or letter of a new contact goes to the AI once (background, an
 * event: within AI_DAILY_BUDGET):
 *  - a new contact = a deal created within AI_INBOUND_HOURS (24) whose first message (Telegram, WhatsApp, e-mail)
 *    is the client's; read AI_INBOUND_WAIT_MIN (3) minutes after it (the client may write in parts) or as soon as
 *    the manager answered; the client's messages up to the manager's first answer, at most 8;
 *  - the AI says the category (заявка / клиент / поставщик / личное / спам / другое), the client type (опт, сеть,
 *    отель, экспорт, розница), the country, the language and «что хочет клиент» with a quote; the contact's
 *    earlier deals, the country code of the phone and the domain of the e-mail help it (nothing more of them);
 *  - stored in deal_inbound (one row per deal); a note «ИИ: новое обращение …» in the deal history
 *    (AI_INBOUND_NOTE; nothing of a letter in it: the history is seen without the «Почта» right too); the
 *    responsible manager is told in the CRM bot (AI_INBOUND_NOTIFY). Nothing is deleted or moved: what is not a
 *    request goes to the list «Новые обращения» of the control page (GET /ai/inbound), where the owner corrects
 *    the category or marks it «просмотрено».
 */
@Injectable()
export class AiInboundService implements OnModuleInit {
  private readonly logger = new Logger('AiInbound');
  /** deals with nothing to read (no text in the client's messages), by the id of their first message */
  private readonly idle = new Map<number, number>();

  constructor(
    private dataSource: DataSource,
    private queue: AiQueueService,
    private notifier: InsightsNotifier,
    private gateway: NotificationGateWay,
  ) {}

  onModuleInit(): void {
    this.queue.register('inbound', (job) => this.run(job));
    this.queue.addTicker('inbound detector', () => this.detect());
  }

  // ------------------------------------------------------------------ detection

  async detect(now = new Date()): Promise<number> {
    if (!AI2.inbound) return 0;
    const params: unknown[] = [CHAT_EVENT_TYPES, AI2.inboundHours];
    const prefix = testPrefixSql(params, 'd');
    const deals: { id: number; first_id: number; first_at: Date; answered: boolean }[] = await this.dataSource.query(
      `SELECT d.id, fe.id AS first_id, fe.created_at AS first_at,
              EXISTS (SELECT 1 FROM event a WHERE a.deal_id = d.id AND a.type = ANY($1) AND a.outgoing
                         AND (a.created_at, a.id) > (fe.created_at, fe.id)) AS answered
         FROM deal d
         CROSS JOIN LATERAL (SELECT e.id, e.outgoing, e.created_at FROM event e
                              WHERE e.deal_id = d.id AND e.type = ANY($1) ORDER BY e.created_at, e.id LIMIT 1) fe
        WHERE d.deleted_at IS NULL AND d.created_at > now() - make_interval(hours => $2::int) AND NOT fe.outgoing ${prefix}
          AND NOT EXISTS (SELECT 1 FROM deal_inbound i WHERE i.deal_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM ai_job j WHERE j.kind = 'inbound' AND j.entity = 'deal' AND j.entity_id = d.id)
        ORDER BY d.created_at, d.id LIMIT 20`,
      params,
    );
    let queued = 0;
    const seen = new Set<number>();
    for (const row of deals) {
      const dealId = Number(row.id);
      seen.add(dealId);
      if (this.idle.get(dealId) === Number(row.first_id)) continue;
      if (!row.answered && now.getTime() - new Date(row.first_at).getTime() < AI2.inboundWaitMin * 60_000) continue;
      try {
        if (await this.consider(dealId, Number(row.first_id))) queued++;
      } catch (error) {
        this.logger.warn(`deal ${dealId}: ${(error as Error).message}`);
      }
    }
    for (const dealId of [...this.idle.keys()]) if (!seen.has(dealId)) this.idle.delete(dealId);
    return queued;
  }

  private async consider(dealId: number, firstId: number): Promise<boolean> {
    const ids: number[] = (
      await this.dataSource.query(
        `SELECT id FROM event WHERE deal_id = $1 AND type = ANY($2) ORDER BY created_at, id LIMIT 15`,
        [dealId, CHAT_EVENT_TYPES],
      )
    ).map((r: any) => Number(r.id));
    const all = await messagesByIds(this.dataSource, dealId, ids, 1500);
    const answer = all.findIndex((m) => m.from === 'manager');
    const messages = (answer < 0 ? all : all.slice(0, answer)).filter((m) => m.from === 'client').slice(0, 8);
    if (!messages.length) {
      this.idle.set(dealId, firstId); // files only, no text
      return false;
    }
    const contact = await this.contact(dealId, messages[0]);
    const { created } = await this.queue.enqueue({
      kind: 'inbound',
      entity: 'deal',
      entityId: dealId,
      inputHash: sha256({ v: PROMPT_VERSION_2.inbound, deal: dealId, messages: messages.map((m) => [m.id, m.text]), contact }),
      input: { deal_id: dealId, event_ids: messages.map((m) => m.id), contact },
      priority: AiPriority.EVENT,
      promptVersion: PROMPT_VERSION_2.inbound,
    });
    return created;
  }

  /** What helps to tell a new client from a known one, and the country: earlier deals, the phone code, the mail domain. */
  private async contact(dealId: number, first: ChatMessage): Promise<InboundContact> {
    const [deal] = await this.dataSource.query(`SELECT company_id, repeat_of_id, created_at FROM deal WHERE id = $1`, [dealId]);
    const people: { phone: string | null; email: string | null; wa_id: string | null }[] = await this.dataSource.query(
      `SELECT u.phone, u.email, u.wa_id FROM deal_user du JOIN "user" u ON u.id = du."userId" WHERE du."dealId" = $1 ORDER BY u.id LIMIT 3`,
      [dealId],
    );
    const [{ n }] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM deal o
        WHERE o.id <> $1 AND o.deleted_at IS NULL AND o.created_at < $2
          AND (($3::int IS NOT NULL AND o.company_id = $3)
               OR EXISTS (SELECT 1 FROM deal_user a JOIN deal_user b ON b."userId" = a."userId" WHERE a."dealId" = o.id AND b."dealId" = $1))`,
      [dealId, deal?.created_at ?? new Date(), deal?.company_id ?? null],
    );
    const phone = people.map((p) => p.phone || (p.wa_id ? String(p.wa_id).split('@')[0] : null)).find(Boolean) ?? null;
    const email = people.map((p) => p.email).find((e) => e && e.includes('@')) ?? null;
    return {
      known: Number(n) > 0 || !!deal?.repeat_of_id,
      earlier_deals: Number(n),
      phone_code: phoneCode(phone),
      email_domain: email ? email.split('@')[1].trim().toLowerCase().slice(0, 64) : null,
      channel: first.channel,
    };
  }

  // ------------------------------------------------------------------ the job

  private async run(job: AiJobRow): Promise<AiOutcome> {
    const dealId = job.entity_id;
    const deal = await loadDeal(this.dataSource, dealId);
    if (!deal) return { skipped: 'сделка удалена' };
    const messages = (await messagesByIds(this.dataSource, dealId, job.input?.event_ids ?? [], 1500)).filter((m) => m.from === 'client');
    if (!messages.length) return { skipped: 'сообщений клиента больше нет в сделке' };
    const contact: InboundContact = job.input?.contact ?? { known: false, earlier_deals: 0, phone_code: null, email_domain: null, channel: messages[0].channel };
    const raw = await this.queue.askJson(job, INBOUND_SYSTEM, inboundPrompt({ now: new Date(), deal, contact, messages }));
    if (!looksLikeInbound(raw)) throw new AiFormatError('ИИ ответил не по формату разбора обращения');
    const reading = cleanInbound(raw, messages);
    const hasEmail = messages.some((m) => m.channel === 'email');
    const inserted = returnedRows(
      await this.dataSource.query(
        `INSERT INTO deal_inbound (deal_id, job_id, event_id, channel, has_email, ai_category, category, country, client_type, language,
                                   wants, quote, quote_event_id, reason, prompt_version)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (deal_id) DO NOTHING RETURNING id`,
        [
          dealId,
          job.id,
          messages[0].id,
          messages[0].channel,
          hasEmail,
          reading.category,
          reading.country,
          reading.client_type,
          reading.language,
          reading.wants || null,
          reading.quote,
          reading.quote_event_id,
          reading.reason || null,
          job.prompt_version,
        ],
      ),
    );
    const id = inserted[0]?.id ? Number(inserted[0].id) : null;
    if (id) {
      await this.note(id, dealId, reading, messages[0].channel, hasEmail);
      await this.notify(id, dealId, deal.number, deal.label, deal.agent_id, reading, messages[0].channel, hasEmail);
      liveAi(this.gateway, dealId, this.logger);
    }
    return { result: { ...reading, channel: messages[0].channel, has_email: hasEmail } };
  }

  /** «ИИ: новое обращение …» in the deal history: a note without an author (nothing of a letter in it). */
  private async note(id: number, dealId: number, reading: InboundReading, channel: string, hasEmail: boolean): Promise<void> {
    if (!AI2.inboundNote) return;
    const line = inboundLine(reading);
    const text = hasEmail
      ? `ИИ: новое обращение (письмо) — ${line}. Подробности — во вкладке «ИИ» сделки.`
      : `ИИ: новое обращение (${CHANNEL_LABEL[channel] ?? channel}) — ${line}.${reading.wants ? ` Клиент хочет: ${reading.wants}` : ''}`;
    try {
      const saved = await this.dataSource.getRepository(Event).save(
        EventBuilder.fromType(EventTypes.NEW_COMMENT)
          .linkToDeal({ id: dealId } as Deal)
          .addAfterState(EventWrapper.fromEntity({ comment: text.slice(0, 2000), files: [], automatic: true, ai: 'inbound' })),
      );
      await this.dataSource.query(`UPDATE deal_inbound SET note_event_id = $2 WHERE id = $1`, [id, saved.id]);
    } catch (error) {
      this.logger.warn(`a note in deal ${dealId} failed: ${(error as Error).message}`);
    }
  }

  /** The responsible manager hears of it in the CRM bot (a letter's words only with the «Почта» right). */
  private async notify(
    id: number,
    dealId: number,
    number: number | null,
    label: string,
    agentId: number | null,
    reading: InboundReading,
    channel: string,
    hasEmail: boolean,
  ): Promise<void> {
    if (!AI2.inboundNotify || !agentId || !this.notifier.enabled) return;
    const [chat] = await this.notifier.chats({ userIds: [agentId] });
    if (!chat) return;
    const agent = await loadStaffUser(this.dataSource, agentId);
    const showText = !hasEmail || (!!agent && new Access(agent).canReadMail);
    const lines = [`🆕 Новое обращение · ${CHANNEL_LABEL[channel] ?? channel}`, inboundLine(reading)];
    if (showText && reading.wants) lines.push(`Хочет: ${reading.wants}`);
    if (showText && reading.quote) lines.push(`«${reading.quote}»`);
    if (reading.category !== 'lead' && reading.category !== 'client') {
      lines.push('Похоже, это не заявка. Сделка не удалена: если ИИ ошибся — исправьте категорию во вкладке «ИИ» сделки.');
    }
    lines.push(`Сделка №${number ?? dealId} «${label}»`);
    const base = crmBase();
    if (base) lines.push(`${base}/deals/${dealId}`);
    if (await this.notifier.send(chat.chat_id, lines.join('\n'))) {
      await this.dataSource.query(`UPDATE deal_inbound SET notified_at = now() WHERE id = $1`, [id]);
    }
  }

  // ------------------------------------------------------------------ the deal page and the owner's list

  private view(row: any, withMail: boolean): Record<string, any> {
    const hidden = row.has_email && !withMail;
    return {
      id: Number(row.id),
      deal_id: Number(row.deal_id),
      channel: row.channel,
      has_email: !!row.has_email,
      category: row.category,
      category_label: INBOUND_CATEGORIES[row.category as keyof typeof INBOUND_CATEGORIES] ?? row.category,
      ai_category: row.ai_category,
      corrected: row.category !== row.ai_category,
      client_type: row.client_type,
      client_type_label: row.client_type ? CLIENT_TYPES[row.client_type as keyof typeof CLIENT_TYPES] ?? row.client_type : null,
      country: row.country,
      language: row.language,
      line: inboundLine(row),
      // a letter's words only with the «Почта» right
      wants: hidden ? null : row.wants,
      quote: hidden ? null : row.quote,
      quote_event_id: hidden ? null : row.quote_event_id === null ? null : Number(row.quote_event_id),
      reason: hidden ? null : row.reason,
      status: row.status,
      reviewed_by: row.reviewer ?? null,
      reviewed_at: row.reviewed_at ?? null,
      notified_at: row.notified_at ?? null,
      created_at: row.created_at,
    };
  }

  /** GET /deals/:id/ai/inbound: the reading of the deal's first message (null: none). The route checked the deal. */
  async forDeal(user: AuthUser, dealId: number): Promise<Record<string, any>> {
    const access = new Access(user);
    const [row] = await this.dataSource.query(
      `SELECT i.*, r.username AS reviewer FROM deal_inbound i LEFT JOIN "user" r ON r.id = i.reviewed_by WHERE i.deal_id = $1`,
      [dealId],
    );
    const [job] = row
      ? [null]
      : await this.dataSource.query(
          `SELECT status FROM ai_job WHERE kind = 'inbound' AND entity = 'deal' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
          [dealId],
        );
    return {
      enabled: AI2.inbound,
      inbound: row ? this.view(row, access.canReadMail) : null,
      reading: !row && job && ['queued', 'running'].includes(job.status),
      categories: Object.entries(INBOUND_CATEGORIES).map(([key, label]) => ({ key, label })),
      can_review: access.isManager,
    };
  }

  /** PATCH /deals/:id/ai/inbound: the category corrected (the deal's update right), «просмотрено» (the owner: admin or manager). */
  async correct(user: AuthUser, dealId: number, body: { category?: string; reviewed?: boolean }): Promise<Record<string, any>> {
    const access = new Access(user);
    if (body.category === undefined && body.reviewed === undefined) throw new BadRequestException('Укажите категорию или «просмотрено»');
    if (body.reviewed !== undefined && !access.isManager) throw new ForbiddenException('Отмечать просмотренные может руководитель');
    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE deal_inbound
            SET category = COALESCE($2, category),
                status = CASE WHEN $3::boolean IS NULL THEN (CASE WHEN $2::text IS NULL THEN status ELSE 'reviewed' END)
                              WHEN $3::boolean THEN 'reviewed' ELSE 'new' END,
                reviewed_by = $4, reviewed_at = now()
          WHERE deal_id = $1 RETURNING id`,
        [dealId, body.category ?? null, body.reviewed ?? null, user.sub],
      ),
    );
    if (!rows[0]) throw new NotFoundException('У этой сделки нет разбора первого обращения');
    liveAi(this.gateway, dealId, this.logger);
    return (await this.forDeal(user, dealId)).inbound;
  }

  /** GET /ai/inbound: «Новые обращения» of the period for the owner — the counts by category and the rows. */
  async list(user: AuthUser, q: InboundListQuery): Promise<Record<string, any>> {
    if (!AI2.inbound) {
      const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM deal_inbound`);
      if (!Number(n)) return { enabled: false, counts: {}, rows: [], total: 0 };
    }
    const access = new Access(user);
    const now = new Date();
    const from = q.from_date && PLAIN_DAY.test(q.from_date) ? dayStart(q.from_date) : new Date(now.getFullYear(), now.getMonth(), 1);
    const last = q.till_date && PLAIN_DAY.test(q.till_date) ? dayStart(q.till_date) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const till = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    const params: unknown[] = [from, till];
    const scope = dealScopeSql(access, params, 'd');
    const joins = `FROM deal_inbound i JOIN deal d ON d.id = i.deal_id AND d.deleted_at IS NULL`;
    const period = `WHERE i.created_at >= $1 AND i.created_at < $2 AND ${scope}`;
    const counts: { category: string; n: number; unseen: number }[] = await this.dataSource.query(
      `SELECT i.category, count(*)::int AS n, count(*) FILTER (WHERE i.status = 'new')::int AS unseen ${joins} ${period} GROUP BY i.category`,
      params,
    );
    const where: string[] = [];
    const category = (q.category ?? 'not_lead').trim();
    if (category === 'lead') where.push(`i.category = 'lead'`);
    else if (category === 'not_lead') where.push(`i.category <> 'lead'`);
    else if (category in INBOUND_CATEGORIES) {
      params.push(category);
      where.push(`i.category = $${params.length}`);
    }
    if (q.status === 'new' || q.status === 'reviewed') {
      params.push(q.status);
      where.push(`i.status = $${params.length}`);
    }
    const filter = where.length ? ` AND ${where.join(' AND ')}` : '';
    const [{ total }] = await this.dataSource.query(`SELECT count(*)::int AS total ${joins} ${period}${filter}`, params);
    const page = Math.max(1, Math.min(1000, Number(q.page) || 1));
    params.push((page - 1) * 50);
    const rows = await this.dataSource.query(
      `SELECT i.*, d.display_id, d.label AS deal_label, d.closed_at, a.username AS agent, r.username AS reviewer
         ${joins} LEFT JOIN "user" a ON a.id = d.agent_id LEFT JOIN "user" r ON r.id = i.reviewed_by
         ${period}${filter}
        ORDER BY i.created_at DESC, i.id DESC LIMIT 50 OFFSET $${params.length}`,
      params,
    );
    return {
      enabled: true,
      switches: { inbound: AI2.inbound, notify: AI2.inboundNotify, note: AI2.inboundNote },
      period: { from: q.from_date ?? null, till: q.till_date ?? null },
      categories: Object.entries(INBOUND_CATEGORIES).map(([key, label]) => ({
        key,
        label,
        count: Number(counts.find((c) => c.category === key)?.n ?? 0),
        unseen: Number(counts.find((c) => c.category === key)?.unseen ?? 0),
      })),
      total: Number(total),
      page,
      rows: rows.map((r: any) => ({
        ...this.view(r, access.canReadMail),
        deal: { id: Number(r.deal_id), number: r.display_id === null ? null : Number(r.display_id), label: r.deal_label, closed: !!r.closed_at },
        agent: r.agent ?? null,
      })),
    };
  }
}
