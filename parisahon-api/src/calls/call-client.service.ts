import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoleEnum, User } from '../user/user.entity';
import { MessengerLookupService, TelegramNamed } from '../messenger/messenger-lookup.service';
import { parseRecordingName } from './recording-name';
import { phoneKeySql } from '../helper/phone';

export interface CallClient {
  // the clients of the call; empty — nobody in the CRM (or the name fits several people)
  contacts: User[];
  // a Telegram call: the one account the manager's Telegram shows under the name of the recording
  telegram: TelegramNamed | null;
  // the name fits several clients: nobody is chosen
  ambiguous: boolean;
  // no contact has the number, but it is the phone of one company (its office line): that company;
  // `contacts` then holds its primary contact, when it has one
  company?: { id: number; name: string } | null;
}

/**
 * Whose call a recording is.
 *  - By the phone number: digits compared, the last 9 are enough (the recorder may omit the country code).
 *    No contact with that number: the company whose own phone it is (a call from the office line).
 *  - A messenger call has no number, only the name on the manager's screen ("Анвар Оптовик"):
 *    the manager's own Telegram tells who is shown under that name (parisahon-telegram-service,
 *    POST /resolve-name) — the client with that Telegram id or phone; for WhatsApp, Viber and the
 *    rest the name is the one of the phone book, found among the Telegram contacts with a number;
 *    otherwise the one client with exactly that name in the CRM. Two candidates: nobody.
 */
@Injectable()
export class CallClientService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    private lookup: MessengerLookupService,
  ) {}

  static digits(phone?: string | null): string {
    return String(phone ?? '').replace(/[^\d]/g, '');
  }

  async find(call: { managerId: number; number?: string | null; name?: string | null; fileName?: string | null }): Promise<CallClient> {
    const digits = CallClientService.digits(call.number);
    if (digits.length >= 7) {
      const contacts = await this.byPhone(digits);
      if (contacts.length) return { contacts, telegram: null, ambiguous: false, company: null };
      const company = await this.companyByPhone(digits);
      if (!company) return { contacts: [], telegram: null, ambiguous: false, company: null };
      const primary = company.primary_contact_id
        ? await this.users.findOne({ where: { id: company.primary_contact_id, role: RoleEnum.CTR_AGENT } })
        : null;
      return { contacts: primary ? [primary] : [], telegram: null, ambiguous: false, company: { id: company.id, name: company.name } };
    }
    const name = (call.name ?? '').trim();
    if (name.length < 2) return { contacts: [], telegram: null, ambiguous: false };

    // A Telegram call: the account Telegram shows under that name. The other messengers show the name
    // from the phone book — the manager's Telegram contacts are that same phone book with the numbers,
    // so there only a contact that has a phone counts.
    let telegram: TelegramNamed | null = null;
    {
      const everyone = await this.lookup.telegramNamed(call.managerId, name);
      const named = parseRecordingName(call.fileName).app === 'telegram' ? everyone : everyone.filter((m) => m.phone);
      if (named.length === 1) {
        telegram = named[0];
        const byId = await this.users.find({ where: { tg_id: telegram.tg_id, role: RoleEnum.CTR_AGENT }, order: { id: 'ASC' } });
        if (byId.length) return { contacts: byId, telegram, ambiguous: false };
        const phone = CallClientService.digits(telegram.phone);
        const byNumber = phone.length >= 7 ? await this.byPhone(phone) : [];
        if (byNumber.length) return { contacts: byNumber, telegram, ambiguous: false };
      } else if (named.length > 1) {
        return { contacts: [], telegram: null, ambiguous: true };
      }
    }
    const namesakes = await this.clients().andWhere('lower(btrim(u.username)) = lower(:name)', { name }).take(2).getMany();
    return { contacts: namesakes.length === 1 ? namesakes : [], telegram, ambiguous: namesakes.length > 1 };
  }

  private clients() {
    return this.users.createQueryBuilder('u').where('u.role = :role', { role: RoleEnum.CTR_AGENT }).orderBy('u.id', 'ASC');
  }

  private byPhone(digits: string): Promise<User[]> {
    return this.clients()
      .andWhere("regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') LIKE :tail", { tail: '%' + digits.slice(-9) })
      .getMany();
  }

  /**
   * The one company (not in the trash) whose own phone ends with these digits; two or more — none.
   * 9 digits and more: by the phone key (the index IDX_company_phone_key), a shorter number by its end.
   */
  private async companyByPhone(digits: string): Promise<{ id: number; name: string; primary_contact_id: number | null } | null> {
    const byKey = digits.length >= 9;
    const rows: { id: number; name: string; primary_contact_id: number | null }[] = await this.users.manager.query(
      `SELECT c.id, c.name, c.primary_contact_id FROM company c
        WHERE c.deleted_at IS NULL
          AND length(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) >= 7
          AND ${byKey ? `${phoneKeySql('c.phone')} = $1` : `regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $1`}
        ORDER BY c.id LIMIT 2`,
      [byKey ? digits.slice(-9) : '%' + digits.slice(-9)],
    );
    return rows.length === 1 ? rows[0] : null;
  }
}
