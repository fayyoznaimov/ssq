import { GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { extname } from 'path';
import { RoleEnum, User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event, EventTypes } from '../events/event.entity';
import { EventBuilder } from '../events/event.builder';
import { File } from '../file/file.entity';
import { ApplyTriggerWhenEnum, WhichFiles } from '../trigger/dto/assign.trigger.dto';
import { TriggerService } from '../trigger/trigger.service';
import { InboxOptions, InboxResult, TelegramInboxService } from '../telegram/telegram-inbox.service';
import { IncomingWhatsAppDto } from './dto/incoming.whatsapp.dto';
import { MessengerLookupService } from '../messenger/messenger-lookup.service';
import { ClientDealsService } from '../messenger/client-deals.service';
import { MessengerFilterService, PHONE_KEY_SQL, keyOf } from '../messenger/messenger-filter.service';
import { normalizePhone } from '../helper/phone';

const STAFF = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/**
 * Where a WhatsApp message of a manager's chat becomes CRM data — the same rules as Telegram
 * (TelegramInboxService):
 *  - not for the CRM: the manager's own number, a colleague's number, a chat marked «Не клиент»,
 *    a message from the phone to somebody who is not in the CRM, and with «только известные
 *    контакты» of the manager any unknown chat (MessengerFilterService);
 *  - the client is found by phone (the last 9 digits, helper/phone.ts), then by WhatsApp chat id;
 *    otherwise a contact (ctr_agent) is created;
 *  - the message goes into ONE deal (ClientDealsService); a message from the phone never opens one;
 *  - the stage's triggers «при сообщении в WhatsApp» run, like for Telegram;
 *  - the same WhatsApp message (wa_message_id between these two people) is never saved twice, in any deal;
 *  - a manager who is no longer a staff user: 410 (the service keeps the message aside).
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
    private filter: MessengerFilterService,
    private triggerService: TriggerService,
  ) {}

  async receive(data: IncomingWhatsAppDto, options: InboxOptions = {}): Promise<InboxResult> {
    const agent = await this.userRepository.findOne({ where: { id: data.agent_id }, withDeleted: true });
    if (!agent) throw new NotFoundException(`Staff user ${data.agent_id} does not exist`);
    if (agent.deleted_at || !STAFF.includes(agent.role)) {
      throw new GoneException(`User ${data.agent_id} is not a staff user any more: the WhatsApp session is to be disconnected`);
    }

    const empty: InboxResult = { status: 'ignored', deal_ids: [], event_ids: [], created_contact: false, created_deal: false };
    const phone = normalizePhone(data.chat.phone ?? null);
    // the manager's own number is never a client
    if (keyOf(phone) && keyOf(phone) === keyOf(data.agent_phone ?? null)) return { ...empty, reason: 'self' };
    // a colleague, or a chat the manager marked «Не клиент»
    if (!options.contact) {
      const reason = await this.filter.reasonToIgnore(agent.id, 'whatsapp', { waId: data.chat.wa_id, phone });
      if (reason) return { ...empty, reason };
    }

    let contact = options.contact ?? (await this.findContact(phone, data.chat.wa_id));
    let createdContact = false;
    if (!contact) {
      // written from the phone to somebody who is not in the CRM: a personal chat until the person writes back
      if (data.outgoing) return { ...empty, reason: 'outgoing_unknown' };
      if (await this.filter.knownOnly(agent.id, 'whatsapp')) return { ...empty, reason: 'unknown_contact' };
      contact = await this.createContact(agent, data, phone);
      createdContact = true;
    } else {
      const patch: Partial<User> = {};
      if (!contact.wa_id && data.chat.wa_id) patch.wa_id = data.chat.wa_id;
      if (!contact.phone && phone) patch.phone = phone;
      if (data.chat.photo && data.chat.photo !== contact.avatar) patch.avatar = data.chat.photo;
      if (Object.keys(patch).length) {
        await this.userRepository.update(contact.id, patch);
        Object.assign(contact, patch);
      }
    }
    // the same number in Telegram, in the background
    if (contact.phone && !contact.tg_id && !data.outgoing) this.lookup.lookupLater(agent.id, contact.id);

    const fromUser = data.outgoing ? agent : contact;
    const toUser = data.outgoing ? contact : agent;

    // idempotent: the same WhatsApp message between these two people, in any deal (also one moved by hand)
    const already: { id: number; deal_id: number | null }[] = await this.eventRepository.query(
      `SELECT id, deal_id FROM event WHERE type = $1 AND external_id = $2 AND user_id = $3 AND target_user_id = $4 ORDER BY id`,
      [EventTypes.NEW_WHATSAPP_MESSAGE, data.wa_message_id, fromUser.id, toUser.id],
    );
    if (already.length) {
      return {
        status: 'duplicate',
        contact_id: contact.id,
        deal_ids: [...new Set(already.map((e) => e.deal_id).filter((id): id is number => Boolean(id)))],
        event_ids: already.map((e) => e.id),
        created_contact: createdContact,
        created_deal: false,
      };
    }

    // ONE deal (ClientDealsService); a message from the phone never opens one
    const choice = await this.clientDeals.dealForMessage(agent, contact, {
      outgoing: data.outgoing,
      dealId: data.deal_id ?? null,
      afterCloseGrace: !data.outgoing,
    });
    if (!choice.deal) {
      return { ...empty, contact_id: contact.id, created_contact: createdContact, reason: choice.reason ?? 'no_deal' };
    }
    const deal = choice.deal;

    await this.saveFiles(data, fromUser, [deal]);
    const afterState = {
      message: data.text ?? '',
      files: (data.files ?? []).map((f) => ({ name: TelegramInboxService.fileName(f), path: f.path, type: f.type, caption: f.caption ?? null })),
      from_user_id: fromUser.id,
      to_user_id: toUser.id,
      outgoing: data.outgoing,
    };
    const date = data.date ? new Date(data.date) : null;
    const event = EventBuilder.fromType(EventTypes.NEW_WHATSAPP_MESSAGE)
      .originatedBy(fromUser)
      .addTargetUser(toUser)
      .linkToDeal(deal)
      .addAfterState(afterState)
      .addCreatedAt(date && !isNaN(date.getTime()) ? date : null);
    event.outgoing = data.outgoing;
    event.external_id = data.wa_message_id;
    const saved = await this.eventRepository.save(event);

    // triggers that wait for a WhatsApp message (WA-3), like Telegram's
    await this.triggerService.onDealEvent(fromUser, deal, ApplyTriggerWhenEnum.WA_MESSAGE_RECEIVED, {
      outgoing: data.outgoing,
      from_user_id: fromUser.id,
    });
    if (choice.afterClose) await this.clientDeals.noteAfterClose(deal, 'WhatsApp');
    this.logger.log(`whatsapp message of user ${agent.id} -> contact ${contact.id}, deal ${deal.id}${choice.afterClose ? ' (closed recently)' : ''}`);
    return {
      status: 'saved',
      contact_id: contact.id,
      deal_ids: [deal.id],
      event_ids: [saved.id],
      created_contact: createdContact,
      created_deal: choice.created,
    };
  }

  private async findContact(phone: string | null, waId: string): Promise<User | null> {
    const key = keyOf(phone);
    if (key) {
      // phones in the CRM are typed by hand ('+998 90 …', '90 123 45 67'): the last 9 digits, an exact number first
      const byPhone = await this.userRepository
        .createQueryBuilder('u')
        .where('u.role = :role', { role: RoleEnum.CTR_AGENT })
        .andWhere(`${PHONE_KEY_SQL('u.phone')} = :key`, { key })
        .orderBy(`(regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = :digits)`, 'DESC')
        .addOrderBy('u.id', 'ASC')
        .setParameter('digits', String(phone ?? '').replace(/\D/g, ''))
        .getOne();
      if (byPhone) return byPhone;
    }
    if (!waId) return null;
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
    const local = (data.files ?? []).filter((f) => f.path);
    if (!local.length) return [];
    const files = local.map((f) => {
      const file = new File();
      file.name = TelegramInboxService.fileName(f);
      file.path = f.path;
      file.extension = extname(f.path) || extname(file.name) || null;
      file.from = WhichFiles.FROM_MESSAGES;
      file.uploaded_by = uploadedBy;
      file.deals = deals;
      return file;
    });
    return this.fileRepository.save(files);
  }
}
