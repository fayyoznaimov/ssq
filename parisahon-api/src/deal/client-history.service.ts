import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Access } from '../auth/access';
import { Deal } from './deal.entity';
import { isWonStage } from '../deal_stage/stage-kind';

/** Deals of the same client: any of the deal's contacts, or its company (also through the contacts' company). */
export const CLIENT_DEALS_SQL = `(
  d.company_id = :company_id
  OR EXISTS (SELECT 1 FROM deal_user du WHERE du."dealId" = d.id AND du."userId" IN (:...contact_ids))
)`;

/** Deals of a company: its own and those of its contacts. */
export const COMPANY_DEALS_SQL = `(
  d.company_id = :company_id
  OR EXISTS (SELECT 1 FROM deal_user du JOIN "user" u ON u.id = du."userId" WHERE du."dealId" = d.id AND u.company_id = :company_id)
)`;

/**
 * "Клиент" in the deal card: who the client is and what they bought before — the other
 * deals of the deal's contacts and company, newest first, with the totals. Answers the
 * question "was there an order from this number before?".
 */
/** Deals of a contact (linked as the deal's contact). */
export const CONTACT_DEALS_SQL = `EXISTS (SELECT 1 FROM deal_user du WHERE du."dealId" = d.id AND du."userId" = :contact_id)`;

@Injectable()
export class ClientHistoryService {
  constructor(@InjectRepository(Deal) private deals: Repository<Deal>) {}

  /** closed in the stage of kind won («успешно реализовано»), like the goals and analytics count it */
  static isWon(deal: Deal): boolean {
    return !!deal.closed_at && isWonStage(deal.stage);
  }

  private static summary(d: Deal) {
    return {
      id: d.id,
      display_id: d.display_id,
      label: d.label,
      budget: Number(d.budget ?? 0),
      created_at: d.created_at,
      closed_at: d.closed_at,
      won: ClientHistoryService.isWon(d),
      stage: d.stage ? { id: d.stage.id, name: d.stage.name, color: d.stage.color } : null,
      agent: d.agent ? { id: d.agent.id, username: d.agent.username } : null,
    };
  }

  /** `access`: only the deals the user may see (DEAL-15: the deals of colleagues with the same client showed). */
  async forDeal(id: number, access?: Access) {
    const deal = await this.deals.findOne({
      where: { id },
      relations: { ctr_agents: { company: true }, company: true, repeat_of: true },
    });
    if (!deal) throw new NotFoundException(`Deal with id ${id} does not exist!`);

    const contacts = (deal.ctr_agents ?? []).map((c) => ({
      id: c.id,
      username: c.username,
      phone: c.phone ?? null,
      email: c.email ?? null,
      avatar: c.avatar ?? null,
      tg_id: c.tg_id ?? null,
      wa_id: c.wa_id ?? null,
      company: c.company ? { id: c.company.id, name: c.company.name } : null,
    }));
    const company = deal.company ?? deal.ctr_agents?.find((c) => c.company)?.company ?? null;
    const contactIds = contacts.map((c) => c.id);
    const scope = ClientHistoryService.scope(access);

    const others = contactIds.length || company
      ? await this.deals
          .createQueryBuilder('d')
          .leftJoinAndSelect('d.stage', 'stage')
          .leftJoinAndSelect('d.agent', 'agent')
          .leftJoinAndSelect('d.company', 'company')
          .where('d.id <> :id', { id })
          .andWhere('d.deleted_at IS NULL')
          .andWhere(CLIENT_DEALS_SQL, { company_id: company?.id ?? 0, contact_ids: contactIds.length ? contactIds : [0] })
          .andWhere(scope.sql, scope.params)
          .orderBy('d.created_at', 'DESC')
          .addOrderBy('d.id', 'DESC')
          .take(50)
          .getMany()
      : [];

    const closed = others.filter((d) => d.closed_at);
    const won = others.filter((d) => ClientHistoryService.isWon(d));
    return {
      deal_id: deal.id,
      contacts,
      company: company ? { id: company.id, name: company.name } : null,
      repeat_of: deal.repeat_of ? { id: deal.repeat_of.id, display_id: deal.repeat_of.display_id, label: deal.repeat_of.label } : null,
      deals: others.map((d) => ({
        ...ClientHistoryService.summary(d),
        company: d.company ? { id: d.company.id, name: d.company.name } : null,
      })),
      totals: {
        count: others.length,
        open: others.length - closed.length,
        closed: closed.length,
        // successful orders and their sum; closed without success = closed - won
        won: won.length,
        won_budget: won.reduce((sum, d) => sum + Number(d.budget ?? 0), 0),
      },
    };
  }

  /** GET /companies/:id/deals — every deal of a company (own and its contacts') the user may see, newest first. */
  async forCompany(companyId: number, access?: Access) {
    return this.list(COMPANY_DEALS_SQL, { company_id: companyId }, access);
  }

  /** GET /users/:id/deals — every deal a contact is linked to that the user may see, newest first. */
  async forContact(contactId: number, access?: Access) {
    return this.list(CONTACT_DEALS_SQL, { contact_id: contactId }, access);
  }

  /** The deals (alias d) the user may see; no `access`: all of them. */
  private static scope(access?: Access): { sql: string; params: Record<string, any> } {
    return access ? access.dealSql('d', 'view') : { sql: 'TRUE', params: {} };
  }

  private async list(condition: string, params: Record<string, any>, access?: Access) {
    const scope = ClientHistoryService.scope(access);
    const list = await this.deals
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.stage', 'stage')
      .leftJoinAndSelect('d.agent', 'agent')
      .leftJoinAndSelect('d.ctr_agents', 'contact')
      .where('d.deleted_at IS NULL')
      .andWhere(condition, params)
      .andWhere(scope.sql, scope.params)
      .orderBy('d.created_at', 'DESC')
      .addOrderBy('d.id', 'DESC')
      .take(500)
      .getMany();
    return list.map((d) => ({
      ...ClientHistoryService.summary(d),
      contacts: (d.ctr_agents ?? []).map((c) => ({ id: c.id, username: c.username, phone: c.phone ?? null })),
    }));
  }
}
