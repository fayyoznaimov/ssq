import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository } from 'typeorm';
import { Access } from '../auth/access';
import { AuthUser } from '../auth/auth.guard';
import { Company } from '../company/company.entity';
import { Deal } from '../deal/deal.entity';
import type { DealService } from '../deal/deal.service';
import { LoggerService } from '../helper/logger.service';
import { RoleEnum, User } from '../user/user.entity';
import { Email } from './email.entity';
import { MailConnectionService } from './mail-connection.service';
import { MailHistoryService } from './mail-history.service';
import { addressesIn, domainOf, isFreeMail, messageIdsIn, nameFromAddress } from './mail-text';

/** POST /emails/deals: one deal per client of the chosen letters. */
export interface DealFromLetters {
  address: string;
  deal: { id: number; label: string; display_id: number };
  contact: { id: number; username: string };
  created_contact: boolean;
  /** letters of this client put into the history of the deal (the chosen ones and the earlier ones) */
  letters: number;
}

/**
 * Which deals a letter belongs to: one rule for letters received, sent from the CRM and sent from
 * a mail program (they come through the Sent mailbox).
 *  - Open deal = not closed (deal.closed_at) and not in the trash, as for Telegram and WhatsApp
 *    (the outgoing side used to check the names of the closing stages instead).
 *  - Received: the open deals of the sender — a contact (whatever their deals are) or the general
 *    address of a company (company.email) — and of the thread (In-Reply-To / References: the deals
 *    of the letter answered, which also catches a reply from the client's colleague).
 *    A contact who had deals but has no open one gets a repeat deal ("повторное обращение"), as in
 *    the messengers, for a letter of the last EMAIL_REPEAT_DEAL_DAYS days (3; 0 never).
 *  - Sent: the open deals of the contacts and company addresses among To / Cc, and of the thread.
 * A sender with no contact is not linked to anything: the manager uses «доб.контакты» / «доб.сделку».
 */
@Injectable()
export class MailDealsService {
  constructor(
    @InjectRepository(Deal) private deals: Repository<Deal>,
    @InjectRepository(User) private users: Repository<User>,
    private dataSource: DataSource,
    private connection: MailConnectionService,
    private history: MailHistoryService,
    private moduleRef: ModuleRef,
    private loggerService: LoggerService,
  ) {}

  async forReceived(email: Email): Promise<Deal[]> {
    const from = (email.from ?? '').toLowerCase();
    const contact = email.from_user?.role === RoleEnum.CTR_AGENT ? email.from_user : null;

    let found = await this.openDeals(contact ? [contact.id] : [], from ? [from] : []);
    found = merge(found, await this.threadDeals(threadIdsOf(email)));

    if (!found.length && contact && this.mayOpenRepeatDeal(email)) {
      try {
        const created = await this.repeatDeal(contact, email);
        if (created) found = [created];
      } catch (error) {
        this.loggerService.error(`mail: repeat deal for contact ${contact.id} failed: ${(error as Error)?.message}`, (error as Error)?.stack);
      }
    }
    return found;
  }

  async forSent(email: Email): Promise<Deal[]> {
    const recipients = addressesIn([...(email.to ?? []).map((r) => r.value), ...(email.cc ?? []).map((r) => r.value)]);
    const contacts = await this.contactIdsOf(recipients);
    return merge(await this.openDeals(contacts, recipients), await this.threadDeals(threadIdsOf(email)));
  }

  /** Open deals where one of `contactIds` is a contact, or whose company has one of `companyAddresses`. */
  async openDeals(contactIds: number[], companyAddresses: string[]): Promise<Deal[]> {
    if (!contactIds.length && !companyAddresses.length) return [];
    return this.deals
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.stage', 'stage')
      .leftJoin('d.company', 'company')
      .where('d.closed_at IS NULL')
      .andWhere(
        new Brackets((w) => {
          if (contactIds.length) {
            w.orWhere('d.id IN (SELECT du."dealId" FROM deal_user du WHERE du."userId" IN (:...mailContactIds))', {
              mailContactIds: contactIds,
            });
          }
          if (companyAddresses.length) {
            w.orWhere('LOWER(company.email) IN (:...mailCompanyAddresses)', { mailCompanyAddresses: companyAddresses });
          }
        }),
      )
      .orderBy('d.id', 'DESC')
      .getMany();
  }

  /** Open deals the letters `messageIds` are in (the thread of a reply). */
  async threadDeals(messageIds: string[]): Promise<Deal[]> {
    if (!messageIds.length) return [];
    const rows: { deal_id: number }[] = await this.dataSource.query(
      `SELECT DISTINCT e.deal_id
         FROM event e
         JOIN email m ON (e.after_state -> 'data') ->> 'id' = m.id::text
        WHERE e.type = 9 AND e.deal_id IS NOT NULL AND m.message_id = ANY($1)`,
      [messageIds],
    );
    const ids = rows.map((row) => Number(row.deal_id));
    if (!ids.length) return [];
    return this.deals
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.stage', 'stage')
      .where('d.id IN (:...threadDealIds)', { threadDealIds: ids })
      .andWhere('d.closed_at IS NULL')
      .getMany();
  }

  async contactIdsOf(addresses: string[]): Promise<number[]> {
    if (!addresses.length) return [];
    const rows = await this.users
      .createQueryBuilder('u')
      .select('u.id', 'id')
      .where('u.role = :role', { role: RoleEnum.CTR_AGENT })
      .andWhere('LOWER(u.email) IN (:...addresses)', { addresses })
      .getRawMany<{ id: number }>();
    return rows.map((row) => Number(row.id));
  }

  /** Staff whose own address or checked mailbox is among `addresses`, in that order of the addresses. */
  async staffOf(addresses: string[]): Promise<User[]> {
    if (!addresses.length) return [];
    const rows: { id: number; address: string }[] = await this.dataSource.query(
      `SELECT u.id, lower(u.email) AS address FROM "user" u
        WHERE u.role <> $2 AND u.deleted_at IS NULL AND lower(u.email) = ANY($1)
       UNION
       SELECT u.id, lower(t.email) AS address FROM email_transporter t JOIN "user" u ON u.id = t.user_id
        WHERE u.role <> $2 AND u.deleted_at IS NULL AND t.verified_at IS NOT NULL AND lower(t.email) = ANY($1)`,
      [addresses, RoleEnum.CTR_AGENT],
    );
    const ids: number[] = [];
    for (const address of addresses) {
      for (const row of rows) if (row.address === address && !ids.includes(Number(row.id))) ids.push(Number(row.id));
    }
    if (!ids.length) return [];
    const users = await this.users.find({ where: { id: In(ids) } });
    return ids.map((id) => users.find((u) => u.id === id)).filter(Boolean);
  }

  /**
   * «доб.сделку» in Mail: for each client of the chosen letters (the sender, or the first recipient
   * of a letter we sent) the contact is found or made (named from the letter, in the company of its
   * domain when exactly one company has it), a deal is opened with them (named after the subject,
   * the chosen manager, custom fields are not asked: the data comes from a channel), and the chosen
   * letters and the earlier letters of that client go into its history.
   */
  async createFromLetters(
    letters: Email[],
    input: { agent_id: number; stage_id?: number },
    me: User,
    authUser: AuthUser,
  ): Promise<DealFromLetters[]> {
    if (!new Access(authUser).can('deal', 'create')) {
      throw new ForbiddenException('Нет права создавать сделки');
    }
    const agent = await this.users.findOne({ where: { id: Number(input.agent_id) } });
    if (!agent || agent.role === RoleEnum.CTR_AGENT) {
      throw new BadRequestException('Ответственным может быть только сотрудник');
    }

    const groups = new Map<string, Email[]>();
    for (const letter of letters) {
      const address = this.counterpart(letter);
      if (!address) continue;
      groups.set(address, [...(groups.get(address) ?? []), letter]);
    }
    if (!groups.size) {
      throw new BadRequestException('В выбранных письмах нет адреса клиента');
    }

    const results: DealFromLetters[] = [];
    for (const [address, group] of groups) {
      const staff = await this.staffOf([address]);
      if (staff.length) {
        throw new BadRequestException(`${address} — адрес сотрудника, сделку с ним не создать`);
      }

      let contact = await this.contactByAddress(address);
      const createdContact = !contact;
      const domainCompany = await this.companyOfDomain(address);
      if (!contact) {
        const made = new User();
        made.username = this.nameFor(address, group).slice(0, 255);
        made.email = address;
        made.role = RoleEnum.CTR_AGENT;
        made.created_by = me;
        if (domainCompany) made.company = domainCompany;
        contact = await this.users.save(made);
        contact.company = domainCompany ?? null;
      }
      const company = contact.company ?? domainCompany ?? null;

      const subject = group.map((l) => subjectLabel(l.subject)).find(Boolean);
      const deal = await this.createDeal(
        agent,
        contact,
        company,
        subject || labelOf(contact, company?.name),
        input.stage_id ? Number(input.stage_id) : undefined,
        me.id,
      );

      // the chosen letters and what came from / went to this client before
      const earlier = await this.lettersOf(address, group.map((l) => l.id));
      const linked = await this.history.add(
        [...group, ...earlier].map((letter) => ({
          email: letter,
          deals: [deal],
          originatedBy: letter.outgoing ? letter.sent_by ?? letter.from_user ?? null : contact,
        })),
      );
      await this.dataSource.query(
        `UPDATE email SET user_id = $1 WHERE user_id IS NULL AND outgoing = false AND lower("from") = $2`,
        [contact.id, address],
      );

      results.push({
        address,
        deal: { id: deal.id, label: deal.label, display_id: deal.display_id },
        contact: { id: contact.id, username: contact.username },
        created_contact: createdContact,
        letters: linked,
      });
    }
    return results;
  }

  /**
   * «доб.контакты» in Mail made contacts of these addresses: the stored letters from them point to
   * the contact (they were "unknown sender"), and when the contact already is in open deals the
   * letters go into their history. Returns how many letters now point to the contacts.
   */
  async linkContacts(userIds: number[]): Promise<{ letters: number; history: number }> {
    const contacts = await this.users
      .createQueryBuilder('u')
      .where('u.id IN (:...linkIds)', { linkIds: [...new Set(userIds.map(Number))] })
      .andWhere('u.role = :role', { role: RoleEnum.CTR_AGENT })
      .getMany();

    let letters = 0;
    let history = 0;
    for (const contact of contacts) {
      const address = String(contact.email ?? '').trim().toLowerCase();
      if (!address) continue;
      const updated: [unknown, number] = await this.dataSource.query(
        `UPDATE email SET user_id = $1 WHERE user_id IS NULL AND outgoing = false AND lower("from") = $2`,
        [contact.id, address],
      );
      letters += Number(updated?.[1] ?? 0);

      const deals = await this.openDeals([contact.id], []);
      if (!deals.length) continue;
      const stored = await this.lettersOf(address, []);
      history += await this.history.add(
        stored.map((letter) => ({
          email: letter,
          deals,
          originatedBy: letter.outgoing ? letter.sent_by ?? letter.from_user ?? null : contact,
        })),
      );
    }
    return { letters, history };
  }

  /** The client of a letter: its sender, or for a letter we sent the first recipient that is not ours. */
  counterpart(email: Email): string | null {
    if (!email.outgoing) return (email.from ?? '').toLowerCase() || null;
    const recipients = addressesIn([...(email.to ?? []).map((r) => r.value), ...(email.cc ?? []).map((r) => r.value)]);
    return recipients.find((address) => !this.isOurAddress(address)) ?? null;
  }

  private isOurAddress(address: string): boolean {
    const shared = String(process.env.EMAIL_DEFAULT_USER ?? '').toLowerCase();
    return address === shared || domainOf(address) === 'parisahome.com' || (!!shared && domainOf(address) === domainOf(shared));
  }

  private async contactByAddress(address: string): Promise<User | null> {
    const contacts = await this.users
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.company', 'company')
      .where('u.role = :role', { role: RoleEnum.CTR_AGENT })
      .andWhere('LOWER(u.email) = :address', { address })
      .orderBy('u.id', 'ASC')
      .getMany();
    return contacts[0] ?? null;
  }

  /** The one company that has this domain (its address or its contacts' ones); none for public mail. */
  private async companyOfDomain(address: string): Promise<Company | null> {
    if (isFreeMail(address)) return null;
    const rows: { id: number }[] = await this.dataSource.query(
      `SELECT c.id FROM company c
        WHERE c.deleted_at IS NULL
          AND (split_part(lower(COALESCE(c.email, '')), '@', 2) = $1
               OR EXISTS (SELECT 1 FROM "user" u WHERE u.company_id = c.id AND u.deleted_at IS NULL
                           AND split_part(lower(COALESCE(u.email, '')), '@', 2) = $1))
        LIMIT 2`,
      [domainOf(address)],
    );
    if (rows.length !== 1) return null;
    return this.dataSource.getRepository(Company).findOne({ where: { id: Number(rows[0].id) } });
  }

  /** The name the client signs with ("Ivan Petrov <ivan@x>"), else one made of the address. */
  private nameFor(address: string, letters: Email[]): string {
    for (const letter of letters) {
      if (!letter.outgoing && (letter.from ?? '').toLowerCase() === address && letter.from_name?.trim()) {
        return letter.from_name.trim();
      }
      for (const row of [...(letter.to ?? []), ...(letter.cc ?? [])]) {
        const match = String(row.value ?? '').match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/);
        if (match && match[2].toLowerCase() === address && match[1].trim()) return match[1].trim();
      }
    }
    return nameFromAddress(address);
  }

  /** Visible letters from / to `address` other than `except`, oldest first, at most 200. */
  private async lettersOf(address: string, except: number[]): Promise<Email[]> {
    const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = `(^|[^A-Za-z0-9._%+-])${escaped}($|[^A-Za-z0-9._-])`;
    const rows: { id: number }[] = await this.dataSource.query(
      `SELECT e.id FROM email e
        WHERE e.deleted_at IS NULL AND e.is_spam = false AND NOT (e.id = ANY($3))
          AND ((e.outgoing = false AND lower(e."from") = $1)
               OR (e.outgoing = true AND (EXISTS (SELECT 1 FROM email_to t WHERE t.email_id = e.id AND t.value ~* $2)
                                       OR EXISTS (SELECT 1 FROM email_cc c WHERE c.email_id = e.id AND c.value ~* $2))))
        ORDER BY e.sent_at ASC NULLS FIRST, e.id ASC
        LIMIT 200`,
      [address, pattern, except.length ? except : [0]],
    );
    if (!rows.length) return [];
    return this.dataSource
      .getRepository(Email)
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.to', 't1')
      .leftJoinAndSelect('t0.cc', 't2')
      .leftJoinAndSelect('t0.files', 't3')
      .leftJoinAndSelect('t0.from_user', 't4')
      .leftJoinAndSelect('t0.sent_by', 't5')
      .where('t0.id IN (:...letterIds)', { letterIds: rows.map((r) => Number(r.id)) })
      .getMany();
  }

  private mayOpenRepeatDeal(email: Email): boolean {
    const days = Number(process.env.EMAIL_REPEAT_DEAL_DAYS ?? 3);
    if (!(days > 0) || email.outgoing || email.is_spam || email.deleted_at) return false;
    if (email.from_mailbox !== this.connection.mailboxes.inbox) return false;
    const sent = email.sent_at ? new Date(email.sent_at).getTime() : 0;
    return sent > Date.now() - days * 86_400_000;
  }

  /** The client wrote again after their deals were closed: a new deal, marked as a repeat of the last one. */
  private async repeatDeal(contact: User, email: Email): Promise<Deal | null> {
    const previous = await this.deals
      .createQueryBuilder('d')
      .innerJoin('d.ctr_agents', 'c', 'c.id = :contactId', { contactId: contact.id })
      .leftJoinAndSelect('d.agent', 'agent')
      .leftJoinAndSelect('d.company', 'company')
      .orderBy('d.id', 'DESC')
      .getOne();
    // never a client before: the manager decides (the buttons in Mail)
    if (!previous) return null;
    // a letter written before the last deal was closed does not open a new one
    if (previous.closed_at && email.sent_at && new Date(email.sent_at) < new Date(previous.closed_at)) return null;

    const addressed = await this.staffOf(
      addressesIn([...(email.to ?? []).map((r) => r.value), ...(email.cc ?? []).map((r) => r.value)]),
    );
    const agent = addressed[0] ?? (previous.agent && previous.agent.role !== RoleEnum.CTR_AGENT ? previous.agent : null);
    if (!agent) return null;

    const company = contact.company ?? previous.company ?? null;
    const deal = await this.createDeal(agent, contact, company, labelOf(contact, company?.name));
    await this.deals.update(deal.id, { repeat_of: { id: previous.id } as Deal });
    (deal as any).repeat_of = { id: previous.id };
    this.loggerService.log(`mail: repeat deal ${deal.id} for contact ${contact.id} (previous ${previous.id})`);
    return deal;
  }

  private async createDeal(
    agent: User,
    contact: User,
    company: Company | null,
    label: string,
    stageId?: number,
    creatorId?: number,
  ): Promise<Deal> {
    const service = await this.dealService();
    return service.create(
      creatorId ?? agent.id,
      {
        label: label.slice(0, 255),
        budget: 0,
        agent_id: agent.id,
        ctr_agent_ids: [contact.id],
        company_id: company?.id,
        stage_id: stageId,
        fillers: [],
        products: [],
      } as any,
      { skipRequiredFields: true },
    );
  }

  /** Imported when used, not at the top: deal -> trigger -> email would be an import cycle of files. */
  private async dealService(): Promise<DealService> {
    const { DealService: Service } = await import('../deal/deal.service');
    return this.moduleRef.get(Service, { strict: false });
  }
}

function merge(first: Deal[], second: Deal[]): Deal[] {
  const out = [...first];
  for (const deal of second) if (!out.some((d) => d.id === deal.id)) out.push(deal);
  return out;
}

/** The Message-IDs of the letters a letter answers. */
export function threadIdsOf(email: Pick<Email, 'in_reply_to' | 'reference_ids'>): string[] {
  return [...new Set([...messageIdsIn(email.in_reply_to), ...messageIdsIn(email.reference_ids)])].slice(-50);
}

/** "Феруз · +998 97 … · ООО Текстиль": what the board shows, as for deals from the messengers. */
function labelOf(contact: Pick<User, 'username' | 'phone'>, companyName?: string | null): string {
  return [contact.username, contact.phone, companyName]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .filter((s, i, all) => all.indexOf(s) === i)
    .join(' · ')
    .slice(0, 255);
}

/** The subject without "Re:", "Fwd:" and the like, as the name of a deal. */
function subjectLabel(subject: string | null | undefined): string {
  let text = String(subject ?? '').trim();
  for (let i = 0; i < 5; i++) {
    const next = text.replace(/^(re|fwd?|fw|aw|wg|sv|ha|на|отв|ответ|пересл|пересылка)\s*(\[\d+\])?\s*:\s*/i, '');
    if (next === text) break;
    text = next;
  }
  return text.slice(0, 255);
}
