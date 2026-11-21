import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { RoleEnum, User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event, EventTypes } from '../events/event.entity';
import { DealService } from '../deal/deal.service';

/**
 * Which deal a client's Telegram / WhatsApp message belongs to (one rule for both):
 *  1. open deals of this client with the manager whose messenger got the message — all of them;
 *  2. otherwise the client's latest open deal with another manager — the conversation
 *     goes on there instead of a second deal;
 *  3. otherwise a new deal of this manager: named "client · phone · company", in the
 *     client's company, and — when the client had deals before — marked as a repeat
 *     ("повторное обращение", repeat_of = the latest of them).
 */
@Injectable()
export class ClientDealsService {
  constructor(
    @InjectRepository(Deal) private deals: Repository<Deal>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Event) private events: Repository<Event>,
    private dealService: DealService,
  ) {}

  async dealsForMessage(agent: User, contact: User): Promise<{ deals: Deal[]; created: boolean }> {
    const open = await this.openDealsOf(contact.id);
    const own = open.filter((d) => d.agent?.id === agent.id);
    if (own.length) return { deals: own, created: false };
    if (open.length) return { deals: [open[0]], created: false };
    return { deals: [await this.createDeal(agent, contact)], created: true };
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
    const open = await this.openDealsOf(contactId);
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

  private async openDealsOf(contactId: number): Promise<Deal[]> {
    return this.deals
      .createQueryBuilder('d')
      .innerJoin('d.ctr_agents', 'c', 'c.id = :contactId', { contactId })
      .leftJoinAndSelect('d.agent', 'agent')
      .where('d.closed_at IS NULL')
      .andWhere('d.deleted_at IS NULL')
      .orderBy('d.id', 'DESC')
      .getMany();
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
