import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { RoleEnum, User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event, EventTypes } from '../events/event.entity';
import { DealService } from '../deal/deal.service';
import { AutoTaskService } from '../automation/auto-task.service';
import { MessengerHealthService } from './messenger-health.service';

/** Messages with the client: where "the conversation goes on" is decided by the latest of them. */
const CHAT_TYPES = [
  EventTypes.NEW_TELEGRAM_MESSAGE,
  EventTypes.NEW_WHATSAPP_MESSAGE,
  EventTypes.NEW_EMAIL,
  EventTypes.NEW_SMS,
  EventTypes.NEW_CALL_RECORDING,
];
const STAFF_ROLES = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/** Label of the task a manager gets when a client writes into a deal that was just closed. */
export const AUTO_AFTER_CLOSE = 'Авто: клиент написал после закрытия сделки';

export interface DealChoice {
  /** null: the message is not recorded (sent from the phone to a client who has no deal at all) */
  deal: Deal | null;
  created: boolean;
  /** the deal was closed a short while ago: the message goes there and the manager gets a task */
  afterClose?: boolean;
  reason?: string;
}

export interface DealChoiceOptions {
  /** the manager wrote it (from the phone, or through the CRM) */
  outgoing?: boolean;
  /** the deal the message was written from in the CRM: it goes there */
  dealId?: number | null;
  /** an incoming message soon after the client's deal was closed goes into that deal (MESSENGER_AFTER_CLOSE_HOURS) */
  afterCloseGrace?: boolean;
  /** «Telegram» / «WhatsApp»: for the note to the manager of a deal the message did not go into */
  channel?: string;
}

interface OpenDealRow {
  id: number;
  agent_id: number | null;
  agent_group_id: number | null;
  agent_active: boolean;
  last_chat_at: Date | null;
  last_event_at: Date | null;
  created_at: Date;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Which deal a client's Telegram / WhatsApp message (and a call that gets a deal) belongs to — ONE
 * deal per message, the same rule for every channel:
 *  0. a message written from a deal in the CRM goes into that deal;
 *  1. the manager's own open deals with the client: the one the conversation goes on in (where the
 *     latest message with this client is: a message moved there by hand pulls the next ones after
 *     it), else the newest;
 *  2. else another manager's open deal with the client, but only a live one (its manager is still
 *     a staff user and something happened in it within MESSENGER_FOREIGN_DEAL_DAYS (30) days) that
 *     this manager may open (Access: the deal view right of the user card). A message never goes
 *     silently into a deal the manager whose messenger it is cannot see (OMNI-7): then rule 3 gives
 *     the manager a deal of their own, and the manager of the other deal is told in the CRM bot;
 *  3. else nothing is open:
 *     - a message the manager wrote from the phone never opens a deal: it goes into the client's
 *       latest deal (the manager's own first, another one only when this manager may open it), or is
 *       not recorded when the client has none. One exception (OMNI-7): the client has a live deal of a
 *       colleague this manager cannot open — then the manager gets a deal of their own, as for a
 *       client's message, so the conversation is neither lost nor hidden;
 *     - a client's message within MESSENGER_AFTER_CLOSE_HOURS (24) after the manager's deal with the
 *       client was closed goes into that deal, and the manager gets a task to look at it
 *       («спасибо, получили» does not open a new deal; a new order is not missed);
 *     - otherwise a new deal of this manager: named "client · phone · company", in the client's
 *       company, marked as a repeat ("повторное обращение", repeat_of = the latest deal) when the
 *       client had deals before.
 */
@Injectable()
export class ClientDealsService {
  private readonly logger = new Logger(ClientDealsService.name);

  constructor(
    @InjectRepository(Deal) private deals: Repository<Deal>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Event) private events: Repository<Event>,
    private dealService: DealService,
    private dataSource: DataSource,
    private autoTasks: AutoTaskService,
    private health: MessengerHealthService,
  ) {}

  static foreignDealDays(): number {
    return envNumber('MESSENGER_FOREIGN_DEAL_DAYS', 30);
  }

  static afterCloseHours(): number {
    return envNumber('MESSENGER_AFTER_CLOSE_HOURS', 24);
  }

  /** Kept for the callers that want a list (call recordings): the one deal of dealForMessage(). */
  async dealsForMessage(agent: User, contact: User): Promise<{ deals: Deal[]; created: boolean }> {
    const choice = await this.dealForMessage(agent, contact, {});
    return { deals: choice.deal ? [choice.deal] : [], created: choice.created };
  }

  async dealForMessage(agent: User, contact: User, options: DealChoiceOptions = {}): Promise<DealChoice> {
    if (options.dealId) {
      const deal = await this.dealOfContact(Number(options.dealId), contact.id);
      if (deal) return { deal, created: false };
    }

    const open = await this.openDealsOf(contact.id);
    const own = open.filter((d) => Number(d.agent_id) === agent.id);
    if (own.length) {
      const chosen = [...own].sort((a, b) => time(b.last_chat_at) - time(a.last_chat_at) || b.id - a.id)[0];
      return { deal: await this.load(chosen.id), created: false };
    }
    const days = ClientDealsService.foreignDealDays();
    const since = Date.now() - days * 24 * 3600 * 1000;
    const recent = (d: OpenDealRow) => Math.max(time(d.last_event_at), time(d.created_at));
    const live = open
      .filter((d) => d.agent_active && (days === 0 || recent(d) >= since))
      .sort((a, b) => recent(b) - recent(a) || b.id - a.id);
    const viewer = live.length ? await this.accessOf(agent) : null;
    const visible = live.filter((d) => viewer!.allowsDeal('view', d.agent_id, d.agent_group_id));
    if (visible.length) return { deal: await this.load(visible[0].id), created: false };
    if (open.length) {
      this.logger.log(
        `contact ${contact.id}: open deal(s) ${open.map((d) => d.id).join(',')} of another manager are stale, orphaned or not visible to user ${agent.id}, not used`,
      );
    }

    if (options.outgoing) {
      const latest = await this.latestDealOf(contact.id, agent.id, false);
      if (!latest) return { deal: null, created: false, reason: 'no_deal' };
      const visible = Number(latest.agent_id) === agent.id || (await this.accessOf(agent)).allowsDeal('view', latest.agent_id, latest.agent_group_id);
      if (visible) return { deal: await this.load(latest.id), created: false };
      // the client is in work with a colleague whose deal this manager cannot open: the manager's
      // conversation is not lost and not hidden in that deal — it gets a deal of its own (and the colleague is told)
      if (!live.length) return { deal: null, created: false, reason: 'no_visible_deal' };
      const deal = await this.createDeal(agent, contact);
      void this.tellForeign(live[0], agent, contact, deal, options.channel);
      return { deal, created: true };
    }
    if (options.afterCloseGrace) {
      const hours = ClientDealsService.afterCloseHours();
      if (hours > 0) {
        const rows: { id: number }[] = await this.dataSource.query(
          `SELECT d.id FROM deal d JOIN deal_user du ON du."dealId" = d.id AND du."userId" = $1
            WHERE d.deleted_at IS NULL AND d.agent_id = $2 AND d.closed_at IS NOT NULL
              AND d.closed_at > now() - ($3::text || ' hours')::interval
            ORDER BY d.closed_at DESC, d.id DESC LIMIT 1`,
          [contact.id, agent.id, String(hours)],
        );
        if (rows[0]) return { deal: await this.load(rows[0].id), created: false, afterClose: true };
      }
    }
    const deal = await this.createDeal(agent, contact);
    // the client already has a live deal of another manager that this one cannot open: that manager is told
    if (live.length) void this.tellForeign(live[0], agent, contact, deal, options.channel);
    return { deal, created: true };
  }

  /** The note to the manager of the client's other open deal: the client wrote to a colleague, who has a deal of their own now. */
  private async tellForeign(foreign: OpenDealRow, agent: User, contact: User, deal: Deal, channel?: string): Promise<void> {
    if (!foreign.agent_id || Number(foreign.agent_id) === agent.id) return;
    try {
      const base = (process.env.CRM_PUBLIC_URL || '').replace(/\/+$/, '');
      const link = (id: number) => (base ? `${base}/deals/${id}` : `№${id}`);
      await this.health.tellUser(
        Number(foreign.agent_id),
        `Клиент «${contact.username || contact.phone || contact.id}» написал${channel ? ` в ${channel}` : ''} менеджеру ${agent.username || agent.id}, ` +
          `у которого нет доступа к вашей сделке ${link(foreign.id)}. Его переписка теперь идёт в его сделку ${link(deal.id)}.`,
      );
    } catch (error) {
      this.logger.warn(`note about deal ${foreign.id}: ${(error as Error).message}`);
    }
  }

  /** The rights of a staff user (role, the user card's permissions, group), as the API checks them on a request. */
  private async accessOf(agent: User): Promise<Access> {
    const rows: { id: number; username: string; role: any; permissions: any; group_id: number | null }[] = await this.dataSource.query(
      `SELECT id, username, role, permissions, group_id FROM "user" WHERE id = $1`,
      [agent.id],
    );
    const row = rows[0];
    const user: AuthUser = {
      sub: agent.id,
      username: row?.username ?? agent.username,
      role: row?.role ?? agent.role,
      permissions: row?.permissions ?? agent.permissions ?? null,
      group_id: row?.group_id ?? null,
    };
    return new Access(user);
  }

  /**
   * A client wrote into a deal that was just closed: a task for its manager (one open task per deal),
   * so that a new order is not missed. Never fails the message.
   */
  async noteAfterClose(deal: Deal, channel: string): Promise<void> {
    try {
      const open = await this.dataSource.query(
        `SELECT 1 FROM task WHERE deal_id = $1 AND closed_at IS NULL AND label LIKE $2 LIMIT 1`,
        [deal.id, `${AUTO_AFTER_CLOSE}%`],
      );
      if (open.length) return;
      await this.autoTasks.create(deal.id, `${AUTO_AFTER_CLOSE} (${channel}): новый заказ — откройте повторную сделку`, new Date(Date.now() + 30 * 60_000));
    } catch (error) {
      this.logger.warn(`after-close task of deal ${deal.id}: ${(error as Error).message}`);
    }
  }

  /** "Феруз · +998 97 … · ООО Текстиль" — what the manager sees on the board. */
  static labelOf(contact: Pick<User, 'username' | 'phone'>, companyName?: string | null): string {
    return [contact.username, contact.phone, companyName]
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .filter((s, i, all) => all.indexOf(s) === i)
      .join(' · ')
      .slice(0, 255);
  }

  /**
   * Open deals of the client the user may write to from the CRM: their own deals; any open
   * deal of the client for admin / manager, or when the client's chat is on the user's
   * own messenger (the client wrote to this user).
   */
  async writableDeals(me: AuthUser, contactId: number): Promise<Deal[]> {
    const open = await this.deals
      .createQueryBuilder('d')
      .innerJoin('d.ctr_agents', 'c', 'c.id = :contactId', { contactId })
      .leftJoinAndSelect('d.agent', 'agent')
      .where('d.closed_at IS NULL')
      .andWhere('d.deleted_at IS NULL')
      .orderBy('d.id', 'DESC')
      .getMany();
    if (!open.length) return [];
    const own = open.filter((d) => d.agent?.id === me.sub);
    if (own.length) return own;
    if (me.role === RoleEnum.ADMIN || me.role === RoleEnum.MANAGER) return open;
    const talked = await this.events
      .createQueryBuilder('e')
      .where('e.type IN (:...types)', { types: [EventTypes.NEW_TELEGRAM_MESSAGE, EventTypes.NEW_WHATSAPP_MESSAGE] })
      .andWhere('((e.user_id = :me AND e.target_user_id = :c) OR (e.user_id = :c AND e.target_user_id = :me))', { me: me.sub, c: contactId })
      .getCount();
    return talked ? open : [];
  }

  /**
   * The deal a message from the CRM is written from: one of writableDeals() (else 400 upstream).
   * Without deal_id (an old client) the routing above decides.
   */
  async writableDeal(me: AuthUser, contactId: number, dealId?: number | null): Promise<{ deals: Deal[]; deal: Deal | null }> {
    const deals = await this.writableDeals(me, contactId);
    if (!dealId) return { deals, deal: null };
    return { deals, deal: deals.find((d) => d.id === Number(dealId)) ?? null };
  }

  // ------------------------------------------------------------------ queries

  private async load(id: number): Promise<Deal> {
    return this.deals.findOne({ where: { id }, relations: { agent: true, stage: true } });
  }

  private async dealOfContact(dealId: number, contactId: number): Promise<Deal | null> {
    const rows = await this.dataSource.query(
      `SELECT d.id FROM deal d JOIN deal_user du ON du."dealId" = d.id AND du."userId" = $2
        WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [dealId, contactId],
    );
    return rows[0] ? this.load(rows[0].id) : null;
  }

  private async openDealsOf(contactId: number): Promise<OpenDealRow[]> {
    return this.dataSource.query(
      `SELECT d.id, d.agent_id, a.group_id AS agent_group_id, d.created_at,
              (a.id IS NOT NULL AND a.deleted_at IS NULL AND a.role = ANY($3)) AS agent_active,
              (SELECT max(e.created_at) FROM event e
                WHERE e.deal_id = d.id AND e.type = ANY($2) AND (e.user_id = $1 OR e.target_user_id = $1)) AS last_chat_at,
              (SELECT max(e.created_at) FROM event e WHERE e.deal_id = d.id) AS last_event_at
         FROM deal d
         JOIN deal_user du ON du."dealId" = d.id AND du."userId" = $1
         LEFT JOIN "user" a ON a.id = d.agent_id
        WHERE d.deleted_at IS NULL AND d.closed_at IS NULL
        ORDER BY d.id DESC`,
      [contactId, CHAT_TYPES, STAFF_ROLES],
    );
  }

  /** The client's latest deal (open or closed): the manager's own first. */
  private async latestDealOf(contactId: number, agentId: number, ownOnly: boolean): Promise<{ id: number; agent_id: number | null; agent_group_id: number | null } | null> {
    const rows: { id: number; agent_id: number | null; agent_group_id: number | null }[] = await this.dataSource.query(
      `SELECT d.id, d.agent_id, a.group_id AS agent_group_id
         FROM deal d JOIN deal_user du ON du."dealId" = d.id AND du."userId" = $1
         LEFT JOIN "user" a ON a.id = d.agent_id
        WHERE d.deleted_at IS NULL ${ownOnly ? 'AND d.agent_id = $2' : ''}
        ORDER BY (d.agent_id IS NOT DISTINCT FROM $2) DESC, COALESCE(d.closed_at, d.created_at) DESC, d.id DESC
        LIMIT 1`,
      [contactId, agentId],
    );
    return rows[0] ?? null;
  }

  private async createDeal(agent: User, contact: User): Promise<Deal> {
    const full = await this.users.findOne({ where: { id: contact.id }, relations: { company: true } });
    const previous = await this.deals
      .createQueryBuilder('d')
      .innerJoin('d.ctr_agents', 'c', 'c.id = :contactId', { contactId: contact.id })
      .leftJoinAndSelect('d.company', 'company')
      .where('d.deleted_at IS NULL')
      .orderBy('d.id', 'DESC')
      .getOne();
    const company = full?.company ?? previous?.company ?? null;
    const deal = await this.dealService.create(
      agent.id,
      {
        label: ClientDealsService.labelOf(full ?? contact, company?.name),
        budget: 0,
        agent_id: agent.id,
        ctr_agent_ids: [contact.id],
        company_id: company?.id,
        fillers: [],
        products: [],
      } as any,
      { skipRequiredFields: true },
    );
    if (previous) {
      await this.deals.update(deal.id, { repeat_of: { id: previous.id } as Deal });
      (deal as any).repeat_of = { id: previous.id };
    }
    return deal;
  }
}

function time(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}
