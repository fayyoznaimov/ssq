import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { extname } from 'path';
import { RoleEnum, User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event, EventTypes } from '../events/event.entity';
import { EventBuilder } from '../events/event.builder';
import { File } from '../file/file.entity';
import { WhichFiles } from '../trigger/dto/assign.trigger.dto';
import { TelegramInboxService, InboxResult } from '../telegram/telegram-inbox.service';
import { IncomingWhatsAppDto } from './dto/incoming.whatsapp.dto';
import { MessengerLookupService } from '../messenger/messenger-lookup.service';
import { ClientDealsService } from '../messenger/client-deals.service';

/**
 * Where a WhatsApp message of a manager's chat becomes CRM data — the same
 * rules as Telegram (TelegramInboxService):
 *  - the client is found by phone digits, then by WhatsApp chat id; otherwise a
 *    contact (ctr_agent) is created (TELEGRAM_KNOWN_CONTACTS_ONLY=true applies
 *    to both messengers: unknown chats are ignored instead);
 *  - the message goes to every open deal of this manager with this client;
 *    without one a deal is created in the default stage;
 *  - the same WhatsApp message (wa_message_id) is never saved twice per deal.
 */
@Injectable()
export class WhatsAppInboxService {
  private readonly logger = new Logger(WhatsAppInboxService.name);

  constructor(
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectRepository(Event) private eventRepository: Repository<Event>,
    @InjectRepository(File) private fileRepository: Repository<File>,
    private lookup: MessengerLookupService,
    private clientDeals: ClientDealsService,
  ) {}

  async receive(data: IncomingWhatsAppDto): Promise<InboxResult> {
    const agent = await this.userRepository.findOne({
      where: { id: data.agent_id, role: In([RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT]) },
    });
    if (!agent) throw new NotFoundException(`Staff user ${data.agent_id} does not exist`);

    const empty: InboxResult = { status: 'ignored', deal_ids: [], event_ids: [], created_contact: false, created_deal: false };
    const phone = TelegramInboxService.normalizePhone(data.chat.phone);
    const agentPhone = TelegramInboxService.normalizePhone(data.agent_phone);
    // the manager's own number is never a client
    if (phone && agentPhone && phone === agentPhone) return { ...empty, reason: 'self' };

    let contact = await this.findContact(phone, data.chat.wa_id);
    let createdContact = false;
    if (!contact) {
      if (TelegramInboxService.knownContactsOnly()) return { ...empty, reason: 'unknown_contact' };
      contact = await this.createContact(agent, data, phone);
      createdContact = true;
    } else {
      const patch: Partial<User> = {};
      if (!contact.wa_id) patch.wa_id = data.chat.wa_id;
      if (!contact.phone && phone) patch.phone = phone;
      if (data.chat.photo && data.chat.photo !== contact.avatar) patch.avatar = data.chat.photo;
      if (Object.keys(patch).length) {
        await this.userRepository.update(contact.id, patch);
        Object.assign(contact, patch);
      }
    }
    // the same number in Telegram, in the background
    if (contact.phone && !contact.tg_id && !data.outgoing) this.lookup.lookupLater(agent.id, contact.id);

    // the client's open deal (own first, else another manager's), else a new one (ClientDealsService)
    const { deals, created: createdDeal } = await this.clientDeals.dealsForMessage(agent, contact);

    // idempotent: a retry of the same WhatsApp message adds nothing
    const already = await this.eventRepository.find({
      select: { id: true, deal: { id: true } },
      where: {
        type: EventTypes.NEW_WHATSAPP_MESSAGE,
        external_id: data.wa_message_id,
        deal: { id: In(deals.map((d) => d.id)) },
      },
      relations: { deal: true },
    });
    const done = new Set(already.map((e) => e.deal.id));
    const targetDeals = deals.filter((d) => !done.has(d.id));
    const base = { contact_id: contact.id, deal_ids: deals.map((d) => d.id), created_contact: createdContact, created_deal: createdDeal };
    if (targetDeals.length === 0) {
      return { status: 'duplicate', ...base, event_ids: already.map((e) => e.id) };
    }

    const fromUser = data.outgoing ? agent : contact;
    const toUser = data.outgoing ? contact : agent;
    await this.saveFiles(data, fromUser, targetDeals);
    const afterState = {
      message: data.text ?? '',
      files: (data.files ?? []).map((f) => ({ name: f.name, path: f.path, type: f.type, caption: f.caption ?? null })),
      from_user_id: fromUser.id,
      to_user_id: toUser.id,
      outgoing: data.outgoing,
    };
    const date = data.date ? new Date(data.date) : null;
    const events = targetDeals.map((deal) => {
      const event = EventBuilder.fromType(EventTypes.NEW_WHATSAPP_MESSAGE)
        .originatedBy(fromUser)
        .addTargetUser(toUser)
        .linkToDeal(deal)
        .addAfterState(afterState)
        .addCreatedAt(date && !isNaN(date.getTime()) ? date : null);
      event.outgoing = data.outgoing;
      event.external_id = data.wa_message_id;
      return event;
    });
    const saved = await this.eventRepository.save(events);
    this.logger.log(`whatsapp message of user ${agent.id} -> contact ${contact.id}, deals ${targetDeals.map((d) => d.id).join(',')}`);
    return { status: 'saved', ...base, event_ids: saved.map((e) => e.id) };
  }

  private async findContact(phone: string | null, waId: string): Promise<User | null> {
    if (phone) {
      // phones in the CRM are typed by hand: compare digits only
      const byPhone = await this.userRepository
        .createQueryBuilder('u')
        .where('u.role = :role', { role: RoleEnum.CTR_AGENT })
        .andWhere("regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = :digits", { digits: phone.slice(1) })
        .orderBy('u.id', 'ASC')
        .getOne();
      if (byPhone) return byPhone;
    }
    return this.userRepository.findOne({ where: { wa_id: waId, role: RoleEnum.CTR_AGENT }, order: { id: 'ASC' } });
  }

  private async createContact(agent: User, data: IncomingWhatsAppDto, phone: string | null): Promise<User> {
    const contact = new User();
    contact.username = (data.chat.name ?? '').trim() || phone || 'WhatsApp';
    contact.role = RoleEnum.CTR_AGENT;
    contact.wa_id = data.chat.wa_id;
    contact.phone = phone;
    contact.avatar = data.chat.photo || null;
    contact.created_by = agent;
    return this.userRepository.save(contact);
  }

  private async saveFiles(data: IncomingWhatsAppDto, uploadedBy: User, deals: Deal[]): Promise<File[]> {
    if (!data.files?.length) return [];
    const files = data.files.map((f) => {
      const file = new File();
      file.name = f.name;
      file.path = f.path;
      file.extension = extname(f.path) || extname(f.name) || null;
      file.from = WhichFiles.FROM_MESSAGES;
      file.uploaded_by = uploadedBy;
      file.deals = deals;
      return file;
    });
    return this.fileRepository.save(files);
  }
}
