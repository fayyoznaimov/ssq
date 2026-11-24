import { Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { DataSource, In, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { LoginThrottle } from '../auth/login-throttle';
import { SIGNED_OUT_EVENT, SignedOut } from '../auth/sign-out';
import { Event, EventTypes } from '../events/event.entity';
import { EventsService } from '../events/events.service';
import { stripFeedSnapshots } from '../events/feed-privacy';
import { historySearchText } from '../history/history-filters';
import { AUDIT_SOURCES, AuditContext } from './audit-context';
import { ACTION_TEXT, AUDIT_ACTIONS, AuditJournal } from './audit-journal';
import { AuditLog } from './audit-log.entity';
import { AuditRenderer, RenderedChange, SOURCE_LABEL } from './audit-render';
import { entityKeys, entityName, specOfEntity, VIRTUAL_ENTITIES } from './audit-registry';
import { SearchAuditDto } from './dto/search.audit.dto';

/** Whose history: the journal page (everything), a deal, a company, a contact or an employee. */
export type HistoryScope =
  | { kind: 'all' }
  | { kind: 'deal'; id: number }
  | { kind: 'company'; id: number }
  | { kind: 'user'; id: number };

export interface HistoryEventItem {
  kind: 'event';
  id: string;
  at: string;
  event: Event;
}

export type HistoryItem = RenderedChange | HistoryEventItem;

export interface HistoryPage {
  data: HistoryItem[];
  count: number;
  page_size: number;
  current_page: number;
  last_page: number;
  /** when the journal of changes was switched on (older changes are only in the business events) */
  journal_start: string | null;
}

/**
 * Business events that are changes of data: since the journal is on, the journal shows them (with
 * the author, the source and every attribute), so the common history does not list them twice:
 * new deal, contact / company in a deal, field values, tasks (new, done, changed), products, stage.
 * Older ones stay: they are the only record of their time.
 */
const COVERED_EVENT_TYPES = [
  EventTypes.NEW_DEAL,
  EventTypes.NEW_CTR_AGENT,
  EventTypes.NEW_COMPANY,
  EventTypes.NEW_FIELD_VALUE,
  EventTypes.NEW_UPDATED_FIELD_VALUE,
  EventTypes.NEW_TASK,
  EventTypes.NEW_TASK_STATUS,
  EventTypes.NEW_TASK_UPDATE,
  EventTypes.NEW_PRODUCT,
  EventTypes.NEW_DEAL_STAGE,
];

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;
const PURGE_CHUNK = 5000;
/** "2026-11-23": a day of the date picker, not a moment */
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Positional parameters ($1, $2…) of one SQL text. */
class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** A condition of src/auth/access.ts (named parameters of the query builder) as positional ones. */
  named(sql: string, params: Record<string, unknown>): string {
    return sql.replace(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => (name in params ? this.add(params[name]) : match));
  }
}

function affected(result: unknown): number {
  if (Array.isArray(result) && typeof result[1] === 'number') return result[1];
  const count = (result as { rowCount?: number })?.rowCount;
  return typeof count === 'number' ? count : 0;
}

/**
 * «История событий»: one history of the CRM in which the business events (the feed: messages,
 * calls, letters, notes, …) and the changes of data (audit_log: who changed what, from where) live
 * together — on the journal page and in the cards of a deal, a company, a contact and an employee,
 * with the visibility of the card itself (src/auth/access.ts). Also: the logins and logouts, and the
 * nightly cleanup by AUDIT_RETENTION_DAYS (default 1095; 0 keeps everything).
 */
@Injectable()
export class AuditService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AuditService.name);
  private timer: NodeJS.Timeout | null = null;
  private start: { value: Date | null; read: number } | null = null;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(AuditLog)
    private readonly auditRepository: Repository<AuditLog>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.AUDIT_RETENTION_DAYS === '0') return;
    this.schedule();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  // ------------------------------------------------------------------ reading

  /** GET /audit/meta: the names the filters of the client show (kinds of objects, of changes, sources). */
  meta(): {
    entities: { key: string; name: string; group: string }[];
    actions: { key: string; name: string }[];
    sources: { key: string; name: string }[];
  } {
    const group = (key: string) => VIRTUAL_ENTITIES[key]?.group ?? specOfEntity(key)?.group ?? 'data';
    return {
      entities: entityKeys()
        // a link of a file and a comment are a part of their deal; the filters name the objects people know
        .map((key) => ({ key, name: entityName(key), group: group(key) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      actions: AUDIT_ACTIONS.filter((key) => key !== 'baseline').map((key) => ({ key, name: ACTION_TEXT[key] ?? key })),
      sources: AUDIT_SOURCES.map((key) => ({ key, name: key === 'web' ? 'сотрудник в CRM' : SOURCE_LABEL[key] ?? key })),
    };
  }

  /** The common history of a scope, newest first; `user` decides what of it may be seen. */
  async history(scope: HistoryScope, query: SearchAuditDto, user: AuthUser): Promise<HistoryPage> {
    const access = new Access(user);
    const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_PAGE, 1), MAX_PAGE);
    const skip = Math.max(Number(query.skip) || 0, 0);
    const kind = query.kind ?? 'all';
    const changesOnly = !!(query.entity?.length || query.action?.length || query.source?.length);
    const eventsOnly = !!query.event_types?.length;

    let staff: { id: number; contact: boolean } | null = null;
    if (scope.kind === 'user') {
      const row = (await this.dataSource.query(`SELECT id, role FROM "user" WHERE id = $1`, [scope.id]))[0];
      if (!row) throw new NotFoundException(`User ${scope.id} not found`);
      staff = { id: scope.id, contact: row.role === 'ctr_agent' };
    }

    const p = new Params();
    const withChanges = kind !== 'events' && !eventsOnly;
    // an employee's own account has no business events; the others only with the changes
    const accountOnly = scope.kind === 'user' && staff && !staff.contact && query.as !== 'actor';
    const withEvents = kind !== 'changes' && !changesOnly && !accountOnly;

    const parts: string[] = [];
    const counts: string[] = [];
    if (withChanges) {
      const where = this.changeWhere(scope, staff, query, access, p);
      parts.push(`SELECT 'c'::text AS kind, a.id AS id, a.at AS at FROM audit_log a WHERE ${where}`);
      counts.push(`(SELECT count(*) FROM audit_log a WHERE ${where})`);
    }
    if (withEvents) {
      const start = kind === 'all' ? await this.journalStart() : null;
      const where = this.eventWhere(scope, staff, query, access, p, start);
      parts.push(`SELECT 'e'::text AS kind, e.id::bigint AS id, e.created_at::timestamptz AS at FROM event e WHERE ${where}`);
      counts.push(`(SELECT count(*) FROM event e WHERE ${where})`);
    }
    const startValue = await this.journalStart();
    const empty: HistoryPage = {
      data: [],
      count: 0,
      page_size: limit,
      current_page: Math.floor(skip / limit) + 1,
      last_page: 0,
      journal_start: startValue ? startValue.toISOString() : null,
    };
    if (!parts.length) return empty;

    const countSql = `SELECT (${counts.join(' + ')})::int AS count`;
    const pageSql = `SELECT kind, id, at FROM (${parts.join(' UNION ALL ')}) x ORDER BY at DESC, id DESC LIMIT ${limit} OFFSET ${skip}`;
    const [countRows, pageRows] = await Promise.all([
      this.dataSource.query(countSql, p.values),
      this.dataSource.query(pageSql, p.values),
    ]);
    const rows: { kind: string; id: string; at: Date }[] = pageRows ?? [];

    const changeIds = rows.filter((r) => r.kind === 'c').map((r) => String(r.id));
    const eventIds = rows.filter((r) => r.kind === 'e').map((r) => Number(r.id));
    const [changes, events] = await Promise.all([this.renderChanges(changeIds), this.loadEvents(eventIds, access)]);
    const byChange = new Map(changes.map((c) => [c.id, c]));
    const byEvent = new Map(events.map((e) => [Number(e.id), e]));

    const data: HistoryItem[] = [];
    for (const row of rows) {
      if (row.kind === 'c') {
        const change = byChange.get(String(row.id));
        if (change) data.push(change);
      } else {
        const event = byEvent.get(Number(row.id));
        if (event) data.push({ kind: 'event', id: `e${event.id}`, at: new Date(row.at).toISOString(), event });
      }
    }
    // a delete + insert of one object merged into one change (AuditRenderer.mergeReplaced): the order stays
    const count = Number(countRows?.[0]?.count ?? 0);
    return { ...empty, data, count, last_page: Math.ceil(count / limit) };
  }

  /** The visible deals of a user as a sub-select; null = every deal (admin, manager). */
  private visibleDeals(access: Access, p: Params): string | null {
    if (access.isManager) return null;
    const cond = access.dealSql('vd', 'view');
    return `(SELECT vd.id FROM deal vd WHERE vd.deleted_at IS NULL AND ${p.named(cond.sql, cond.params)})`;
  }

  private changeWhere(scope: HistoryScope, staff: { id: number; contact: boolean } | null, query: SearchAuditDto, access: Access, p: Params): string {
    const where: string[] = [];
    const baseline = query.with_baseline === '1' || query.with_baseline === 'true';
    if (!baseline) where.push(`a.action <> 'baseline'`);
    // made only where it is used: a parameter nobody refers to is an error of the database
    const onlyVisibleDeals = () => {
      const visible = this.visibleDeals(access, p);
      if (visible) where.push(`(a.deal_id IS NULL OR a.deal_id IN ${visible})`);
    };

    if (scope.kind === 'deal') where.push(`a.deal_id = ${p.add(scope.id)}`);
    if (scope.kind === 'company') {
      where.push(`a.company_id = ${p.add(scope.id)}`);
      onlyVisibleDeals();
    }
    if (scope.kind === 'user' && staff) {
      const id = p.add(staff.id);
      if (staff.contact) {
        where.push(`a.contact_id = ${id}`);
        onlyVisibleDeals();
      } else if (query.as === 'actor') {
        where.push(`a.actor_id = ${id}`);
        onlyVisibleDeals();
      } else {
        // the account: its changes, logins, the bot, the messengers, the recorder token and the mailbox
        where.push(
          `((a.entity IN ('user', 'auth', 'bot_account', 'messenger') AND a.entity_id = ${id})
            OR (a.entity IN ('recorder_token', 'mailbox')
                AND (a.after_state ->> 'user_id' = ${id}::text OR a.before_state ->> 'user_id' = ${id}::text)))`,
        );
      }
    }
    // the journal page (admin and manager)
    if (query.deal_id) where.push(`a.deal_id = ${p.add(Number(query.deal_id))}`);
    if (query.company_id) where.push(`a.company_id = ${p.add(Number(query.company_id))}`);
    if (query.contact_id) where.push(`a.contact_id = ${p.add(Number(query.contact_id))}`);

    if (query.entity?.length) where.push(`a.entity = ANY(${p.add(query.entity)}::varchar[])`);
    if (query.action?.length) where.push(`a.action = ANY(${p.add(query.action)}::varchar[])`);
    if (query.source?.length) where.push(`a.source = ANY(${p.add(query.source)}::varchar[])`);
    if (query.actor_id) where.push(`a.actor_id = ${p.add(Number(query.actor_id))}`);
    where.push(...this.period('a.at', query, p));
    // the words of the line, the author, the values as they were stored (a name, a phone, a sum)
    if (query.q?.trim()) {
      const text = p.add(`%${AuditService.likeText(query.q.trim())}%`);
      where.push(`(a.summary ILIKE ${text} OR a.actor_name ILIKE ${text} OR a.changes::text ILIKE ${text})`);
    }
    return where.length ? where.join(' AND ') : 'TRUE';
  }

  private eventWhere(
    scope: HistoryScope,
    staff: { id: number; contact: boolean } | null,
    query: SearchAuditDto,
    access: Access,
    p: Params,
    start: Date | null,
  ): string {
    const where: string[] = [];

    const companyEvents = (id: string) =>
      `(e.deal_id IN (SELECT d.id FROM deal d WHERE d.deleted_at IS NULL
          AND (d.company_id = ${id} OR EXISTS (SELECT 1 FROM deal_user du JOIN "user" u ON u.id = du."userId"
                                              WHERE du."dealId" = d.id AND u.company_id = ${id})))
        OR (e.deal_id IS NULL AND e.company_id = ${id}))`;
    const contactEvents = (id: string) =>
      `(e.user_id = ${id} OR e.target_user_id = ${id} OR e.contact_id = ${id}
        OR e.deal_id IN (SELECT du."dealId" FROM deal_user du WHERE du."userId" = ${id}))`;

    if (scope.kind === 'deal') where.push(`e.deal_id = ${p.add(scope.id)}`);
    if (scope.kind === 'company') where.push(companyEvents(p.add(scope.id)));
    if (scope.kind === 'user' && staff) {
      const id = p.add(staff.id);
      where.push(staff.contact ? contactEvents(id) : `e.user_id = ${id}`);
    }
    // a card that spans deals: only the deals the user may see (a deal's card is checked by DealAccess)
    if (scope.kind !== 'deal' && scope.kind !== 'all') {
      const visible = this.visibleDeals(access, p);
      if (visible) where.push(`(e.deal_id IS NULL OR e.deal_id IN ${visible})`);
    }

    if (query.deal_id) where.push(`e.deal_id = ${p.add(Number(query.deal_id))}`);
    if (query.company_id) where.push(companyEvents(p.add(Number(query.company_id))));
    if (query.contact_id) where.push(contactEvents(p.add(Number(query.contact_id))));
    if (query.actor_id) where.push(`e.user_id = ${p.add(Number(query.actor_id))}`);
    if (query.event_types?.length) where.push(`e.type = ANY(${p.add(query.event_types.map(Number))}::int[])`);
    // what the journal shows better since it is on
    if (start && AuditJournal.enabled()) {
      where.push(`NOT (e.type = ANY(${p.add(COVERED_EVENT_TYPES)}::int[]) AND e.created_at >= ${p.add(start)}::timestamptz)`);
    }
    where.push(...this.period('e.created_at', query, p));
    // the text of a message, a note, a task…; a letter's only for a user who may read mail (history-filters.ts)
    if (query.q?.trim()) where.push(`${historySearchText('e', access.canReadMail)} ILIKE ${p.add(`%${AuditService.likeText(query.q.trim())}%`)}`);
    return where.length ? where.join(' AND ') : 'TRUE';
  }

  /** The period, inclusive: a date is a whole day in the zone of the CRM. */
  private period(column: string, query: SearchAuditDto, p: Params): string[] {
    const out: string[] = [];
    if (query.from) {
      const from = String(query.from).trim();
      out.push(PLAIN_DATE.test(from) ? `${column} >= ${p.add(from)}::date` : `${column} >= ${p.add(from)}::timestamptz`);
    }
    if (query.till) {
      const till = String(query.till).trim();
      out.push(
        PLAIN_DATE.test(till) ? `${column} < (${p.add(till)}::date + interval '1 day')` : `${column} <= ${p.add(till)}::timestamptz`,
      );
    }
    return out;
  }

  static likeText(value: string): string {
    return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  }

  private async renderChanges(ids: string[]): Promise<RenderedChange[]> {
    if (!ids.length) return [];
    const rows = await this.auditRepository.find({ where: { id: In(ids) } });
    const order = new Map(ids.map((id, index) => [id, index]));
    rows.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
    return new AuditRenderer(this.dataSource).render(rows);
  }

  /** The events of a page as the feeds give them: people by name, private parts of snapshots out, mail by the switch. */
  private async loadEvents(ids: number[], access: Access): Promise<Event[]> {
    if (!ids.length) return [];
    let qb = this.eventRepository.createQueryBuilder('t0').where('t0.id IN (:...history_ids)', { history_ids: ids });
    qb = EventsService.withFeedRelations(qb, true)
      .leftJoin('t0.company', 'ev_company')
      .addSelect(['ev_company.id', 'ev_company.name'])
      .leftJoin('t0.task', 'ev_task')
      .addSelect(['ev_task.id', 'ev_task.label']);
    const rows = await qb.getMany();
    stripFeedSnapshots(rows);
    return EventsService.hideMail({ data: rows }, access.canReadMail).data;
  }

  /** The moment the journal was switched on (its baseline), read once in a while. */
  async journalStart(): Promise<Date | null> {
    if (this.start && Date.now() - this.start.read < 10 * 60_000) return this.start.value;
    let value: Date | null = null;
    try {
      const row = (
        await this.dataSource.query(
          `SELECT COALESCE((SELECT min(at) FROM audit_log WHERE action = 'baseline'), (SELECT min(at) FROM audit_log)) AS start`,
        )
      )[0];
      value = row?.start ? new Date(row.start) : null;
    } catch (error) {
      this.logger.warn(`journal start: ${(error as Error).message}`);
    }
    this.start = { value, read: Date.now() };
    return value;
  }

  // ------------------------------------------------------------------ logins

  private static where(request: Request): Record<string, unknown> {
    const agent = request?.headers?.['user-agent'];
    return { ip: LoginThrottle.clientAddress(request), user_agent: typeof agent === 'string' ? agent.slice(0, 255) : null };
  }

  /** POST /auth/login answered with a token. */
  async loginSucceeded(request: Request, body: any): Promise<void> {
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) return;
    const name = typeof body?.username === 'string' ? body.username : null;
    AuditContext.setActor(id, name);
    await AuditJournal.record(this.dataSource, {
      entity: 'auth',
      entityId: id,
      action: 'login',
      actorId: id,
      actorName: name,
      summary: `Вход в CRM${name ? `: ${name}` : ''}`,
      meta: AuditService.where(request),
    });
  }

  /** POST /auth/login refused: the e-mail that was typed (never the password), the address, why. */
  async loginFailed(request: Request, status: number): Promise<void> {
    // 400: nothing typed (the form checks it); other statuses are not an attempt to guess
    if (status !== 401 && status !== 429) return;
    try {
      const email = String(request?.body?.email ?? '').trim().slice(0, 255);
      if (!email) return;
      const account = (
        await this.dataSource.query(
          `SELECT id FROM "user" WHERE lower(email) = lower($1) AND role <> 'ctr_agent' ORDER BY (email = $1) DESC, id LIMIT 1`,
          [email],
        )
      )[0];
      await AuditJournal.record(this.dataSource, {
        entity: 'auth',
        entityId: account?.id ?? null,
        action: 'login_failed',
        actorId: null,
        actorName: null,
        summary: `Неудачная попытка входа: ${email}`,
        meta: {
          email,
          reason: status === 429 ? 'слишком много попыток, вход временно закрыт' : 'неверная почта или пароль',
          ...AuditService.where(request),
        },
      });
    } catch (error) {
      this.logger.warn(`cannot record a failed login: ${(error as Error).message}`);
    }
  }

  /** POST /audit/logout: the user leaves the CRM on this device (the token is forgotten by the browser). */
  async loggedOut(user: AuthUser, request: Request): Promise<void> {
    await AuditJournal.record(this.dataSource, {
      entity: 'auth',
      entityId: user.sub,
      action: 'logout',
      summary: `Выход из CRM: ${user.username ?? user.sub}`,
      meta: AuditService.where(request),
    });
  }

  /** «Выйти на всех устройствах», a new password, a deleted employee (auth/sign-out.ts): every token is void. */
  @OnEvent(SIGNED_OUT_EVENT)
  async onSignedOut(result: SignedOut): Promise<void> {
    if (!result?.userId) return;
    const bot = result.chatIds?.length ?? 0;
    await AuditJournal.record(this.dataSource, {
      entity: 'auth',
      entityId: result.userId,
      action: 'logout',
      summary: `Выход на всех устройствах${bot ? ', Telegram-бот CRM отключён' : ''}`,
      // the token version itself is not kept, only that every session ended
      meta: { everywhere: true, ...(bot ? { bot_unlinked: bot } : {}) },
    });
  }

  // ------------------------------------------------------------------ retention

  /** Every night at 03:40: rows older than AUDIT_RETENTION_DAYS go (the baseline stays). */
  private schedule(): void {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 40, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    this.timer = setTimeout(() => {
      AuditContext.run({ source: 'system', sourceRef: 'retention' }, () => this.purgeExpired())
        .catch((error) => this.logger.warn(`journal cleanup: ${(error as Error).message}`))
        .finally(() => this.schedule());
    }, next.getTime() - now.getTime());
    this.timer.unref?.();
  }

  async purgeExpired(): Promise<number> {
    const days = Number(process.env.AUDIT_RETENTION_DAYS ?? 1095);
    if (!Number.isFinite(days) || days <= 0) return 0;
    let total = 0;
    for (let round = 0; round < 200; round++) {
      const deleted = await this.dataSource.transaction(async (manager) => {
        // the journal is immutable (trigger audit_log_guard): only this switch lets the cleanup delete
        await manager.query(`SELECT set_config('parisa.audit_purge', 'on', true)`);
        return affected(
          await manager.query(
            `DELETE FROM audit_log WHERE id IN (
               SELECT id FROM audit_log WHERE action <> 'baseline' AND at < now() - make_interval(days => $1::int) LIMIT ${PURGE_CHUNK})`,
            [Math.floor(days)],
          ),
        );
      });
      total += deleted;
      if (deleted < PURGE_CHUNK) break;
    }
    if (total) this.logger.log(`journal: ${total} row(s) older than ${days} days removed`);
    return total;
  }
}
