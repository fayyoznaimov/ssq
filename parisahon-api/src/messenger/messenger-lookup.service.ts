import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoleEnum, User } from '../user/user.entity';
import { normalizePhone } from '../helper/phone';
import {
  telegramServiceConfigured,
  telegramServiceHeaders,
  telegramServiceUrl,
  whatsappServiceConfigured,
  whatsappServiceHeaders,
  whatsappServiceUrl,
} from './messenger-services';

/**
 * A client who writes in one messenger is looked up in the other one by phone, so the
 * manager can answer where it suits: a WhatsApp client gets tg_id (Telegram service
 * POST /resolve-phone, through the manager's own Telegram), a Telegram client gets wa_id
 * (WhatsApp service POST /resolve). Runs in the background after the message is saved;
 * a manager without the other messenger connected, or a number without it, changes nothing.
 * Each contact is looked up at most once a day per process (Telegram limits phone lookups).
 * A Telegram id / WhatsApp chat that is another contact's already is not copied (a possible
 * duplicate of the client, logged: contacts are merged by people, not here).
 */
export interface TelegramNamed {
  tg_id: number;
  phone: string | null;
  username: string | null;
}

@Injectable()
export class MessengerLookupService {
  private readonly logger = new Logger(MessengerLookupService.name);
  private readonly recent = new Map<number, number>();

  constructor(@InjectRepository(User) private users: Repository<User>) {}

  lookupLater(agentId: number, contactId: number): void {
    const last = this.recent.get(contactId) ?? 0;
    if (Date.now() - last < 24 * 3600 * 1000) return;
    this.recent.set(contactId, Date.now());
    setImmediate(() => {
      this.lookup(agentId, contactId).catch((error) =>
        this.logger.warn(`lookup of contact ${contactId}: ${(error as Error).message}`),
      );
    });
  }

  async lookup(agentId: number, contactId: number): Promise<Partial<User>> {
    const contact = await this.users.findOne({ where: { id: contactId, role: RoleEnum.CTR_AGENT } });
    // the services need the country code: a local '90 123 45 67' becomes '+998901234567' (helper/phone.ts)
    const phone = normalizePhone(contact?.phone ?? null);
    if (!contact || !phone) return {};
    const patch: Partial<User> = {};
    if (!contact.tg_id) {
      // the client's CRM name: Telegram saves the number in the manager's contacts under it
      const found = await this.telegram({ user_id: agentId, phone, first_name: contact.username });
      const tgId = Number(found?.tg_id);
      if (tgId > 0) {
        const other = await this.users.findOne({ where: { tg_id: tgId, role: RoleEnum.CTR_AGENT }, order: { id: 'ASC' } });
        // the same person is already another contact (a Telegram chat without the number): a possible duplicate
        if (other && other.id !== contact.id) this.logger.warn(`contact ${contact.id}: Telegram ${tgId} is contact ${other.id} already (possible duplicate)`);
        else patch.tg_id = tgId;
      }
      if (!contact.avatar && found?.photo) patch.avatar = found.photo;
    }
    if (!contact.wa_id) {
      const found = await this.whatsapp({ user_id: agentId, phone });
      const waId = found?.wa_id ? String(found.wa_id).slice(0, 64) : '';
      if (waId) {
        const other = await this.users.findOne({ where: { wa_id: waId, role: RoleEnum.CTR_AGENT }, order: { id: 'ASC' } });
        if (other && other.id !== contact.id) this.logger.warn(`contact ${contact.id}: WhatsApp chat is contact ${other.id} already (possible duplicate)`);
        else patch.wa_id = waId;
      }
      if (!contact.avatar && !patch.avatar && found?.photo) patch.avatar = found.photo;
    }
    if (Object.keys(patch).length) {
      await this.users.update(contact.id, patch);
      this.logger.log(`contact ${contact.id}: found ${Object.keys(patch).join(', ')}`);
    }
    return patch;
  }

  /**
   * The Telegram accounts the manager's own Telegram shows under this name (contacts, then the
   * latest chats): a call recorder knows a Telegram call by the name on the screen only.
   */
  async telegramNamed(agentId: number, name: string): Promise<TelegramNamed[]> {
    const found = await this.telegram({ user_id: agentId, name }, '/resolve-name');
    const matches: any[] = Array.isArray(found?.matches) ? found.matches : [];
    return matches
      .filter((m) => Number(m?.tg_id) > 0)
      .map((m) => ({ tg_id: Number(m.tg_id), phone: m.phone ? String(m.phone) : null, username: m.username ? String(m.username) : null }));
  }

  private async telegram(body: any, path = '/resolve-phone'): Promise<any> {
    if (!telegramServiceConfigured()) return null;
    return this.post(`${telegramServiceUrl()}${path}`, body, telegramServiceHeaders());
  }

  private async whatsapp(body: any): Promise<any> {
    if (!whatsappServiceConfigured()) return null;
    return this.post(`${whatsappServiceUrl()}/resolve`, body, whatsappServiceHeaders());
  }

  private async post(url: string, body: any, headers: Record<string, string>): Promise<any> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      return response.ok ? await response.json().catch(() => null) : null;
    } catch {
      return null;
    }
  }
}
