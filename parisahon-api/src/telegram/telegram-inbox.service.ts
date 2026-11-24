import { GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { extname } from 'path';
import { randomBytes } from 'crypto';
import { RoleEnum, User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event, EventTypes } from '../events/event.entity';
import { EventBuilder } from '../events/event.builder';
import { File } from '../file/file.entity';
import { FileService } from '../file/file.service';
import { WhichFiles } from '../trigger/dto/assign.trigger.dto';
import { TriggerService } from '../trigger/trigger.service';
import { ApplyTriggerWhenEnum } from '../trigger/dto/assign.trigger.dto';
import { IncomingFileDto, IncomingMessageDto } from './dto/incoming.message.dto';
import { MessengerLookupService } from '../messenger/messenger-lookup.service';
import { ClientDealsService } from '../messenger/client-deals.service';
import { MessengerFilterService, PHONE_KEY_SQL, keyOf } from '../messenger/messenger-filter.service';
import { normalizePhone } from '../helper/phone';
import { ACCOUNT_SQL, CHAT_SQL, isUniqueViolation, withChatLock } from '../messenger/message-key';

export interface InboxResult {
  status: 'saved' | 'duplicate' | 'ignored' | 'updated';
  reason?: string;
  contact_id?: number;
  deal_ids: number[];
  event_ids: number[];
  created_contact: boolean;
  created_deal: boolean;
}

/** Internal callers (a message sent from the CRM): the contact is the one the manager chose, not looked up again. */
export interface InboxOptions {
  contact?: User;
}

const STAFF = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/**
 * Where a Telegram message of a manager's chat becomes CRM data.
 *
 * The service posts every message here (POST /telegram/incoming) and the CRM's own services do
 * the writing:
 *  - not for the CRM (ignored, no contact, no deal): the manager's own account, a colleague (a
 *    staff user's Telegram id or phone), a chat the manager marked «Не клиент», a message the
 *    manager wrote from the phone to somebody who is not in the CRM, and — with «только известные
 *    контакты» of the manager — any chat with somebody who is not in the CRM (MessengerFilterService);
 *  - the client is found by Telegram id, then by phone (the last 9 digits, helper/phone.ts);
 *    otherwise a new contact (ctr_agent) is created without a company;
 *  - the message goes into ONE deal (ClientDealsService: the deal it was written from, the
 *    manager's open deal the conversation goes on in, a live deal of another manager, after a
 *    close the just-closed deal with a task, else a new deal in the default stage — NEW_DEAL /
 *    NEW_CTR_AGENT events and the stage's triggers run); a message from the phone never opens a deal;
 *  - the same Telegram message (key: the manager's account, the chat, the message id — messenger/message-key.ts,
 *    a unique index) is never saved twice, in any deal, so the service may retry after a failure, also
 *    in parallel (the deliveries of one chat run one after another); an edit (edited: true) updates the text;
 *  - a manager who is no longer a staff user: 410 (the service keeps the message aside).
 */
@Injectable()
export class TelegramInboxService {
  private readonly logger = new Logger(TelegramInboxService.name);

  constructor(
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectRepository(Event) private eventRepository: Repository<Event>,
    @InjectRepository(File) private fileRepository: Repository<File>,
    private triggerService: TriggerService,
    private lookup: MessengerLookupService,
    private clientDeals: ClientDealsService,
    private filter: MessengerFilterService,
  ) {}

  /** The global default of «только известные контакты» (per manager: MessengerFilterService.knownOnly). */
  static knownContactsOnly(): boolean {
    return MessengerFilterService.globalKnownOnly();
  }

  /** "+998 90 123-45-67" -> "+998901234567" (helper/phone.ts); null when there is no number. */
  static normalizePhone(phone?: string | null): string | null {
    return normalizePhone(phone ?? null);
  }

  async receive(data: IncomingMessageDto, options: InboxOptions = {}): Promise<InboxResult> {
    const agent = await this.userRepository.findOne({ where: { id: data.agent_id }, withDeleted: true });
    if (!agent) {
      throw new NotFoundException(`Staff user ${data.agent_id} does not exist`);
    }
    if (agent.deleted_at || !STAFF.includes(agent.role)) {
      throw new GoneException(`User ${data.agent_id} is not a staff user any more: the Telegram session is to be disconnected`);
    }
    if (data.agent_tg_id && Number(agent.tg_id) !== Number(data.agent_tg_id)) {
      await this.userRepository.update(agent.id, { tg_id: data.agent_tg_id });
      agent.tg_id = data.agent_tg_id;
    }
    // one chat at a time: two copies of a first message must not open two contacts or deals
    return withChatLock(`tg:${agent.id}:${data.chat?.tg_id}`, () => this.receiveFor(agent, data, options));
  }

  private async receiveFor(agent: User, data: IncomingMessageDto, options: InboxOptions): Promise<InboxResult> {
    const empty: InboxResult = {
      status: 'ignored',
      deal_ids: [],
      event_ids: [],
      created_contact: false,
      created_deal: false,
    };

    // the manager's own Telegram account is never a client
    if (Number(data.chat.tg_id) === Number(agent.tg_id)) {
      return { ...empty, reason: 'self' };
    }
    // a colleague, or a chat the manager marked «Не клиент»
    if (!options.contact) {
      const reason = await this.filter.reasonToIgnore(agent.id, 'telegram', { tgId: data.chat.tg_id, phone: data.chat.phone });
      if (reason) return { ...empty, reason };
    }

    let contact = options.contact ?? (await this.findContact(data.chat.tg_id, data.chat.phone));
    let createdContact = false;
    if (!contact) {
      // written from the phone to somebody who is not in the CRM: a personal chat until the person writes back
      if (data.outgoing) return { ...empty, reason: 'outgoing_unknown' };
      if (data.edited) return { ...empty, reason: 'edit_of_unknown_message' };
      if (await this.filter.knownOnly(agent.id, 'telegram')) {
        return { ...empty, reason: 'unknown_contact' };
      }
      contact = await this.createContact(agent, data);
      createdContact = true;
    } else {
      const patch: Partial<User> = {};
      if (!contact.tg_id) patch.tg_id = data.chat.tg_id;
      if (!contact.phone && data.chat.phone) patch.phone = normalizePhone(data.chat.phone);
      if (data.chat.photo && data.chat.photo !== contact.avatar) patch.avatar = data.chat.photo;
      if (Object.keys(patch).length) {
        await this.userRepository.update(contact.id, patch);
        Object.assign(contact, patch);
      }
    }
    // the same number in WhatsApp, in the background
    if (contact.phone && !contact.wa_id && !data.outgoing) this.lookup.lookupLater(agent.id, contact.id);

    const fromUser = data.outgoing ? agent : contact;
    const toUser = data.outgoing ? contact : agent;

    // idempotent: the same Telegram message of this account in this chat, in any deal (also one moved by hand)
    const already = await this.stored(data.tg_message_id, agent.id, contact.id);
    if (data.edited) {
      return already.length ? this.applyEdit(already, data, contact) : { ...empty, contact_id: contact.id, reason: 'edit_of_unknown_message' };
    }
    if (already.length) return TelegramInboxService.duplicate(already, contact.id, createdContact);

    // ONE deal (ClientDealsService); a message from the phone never opens one
    const choice = await this.clientDeals.dealForMessage(agent, contact, {
      outgoing: data.outgoing,
      dealId: data.deal_id ?? null,
      afterCloseGrace: !data.outgoing,
      channel: 'Telegram',
    });
    if (!choice.deal) {
      return { ...empty, contact_id: contact.id, created_contact: createdContact, reason: choice.reason ?? 'no_deal' };
    }
    const deal = choice.deal;

    const eventFiles = [];
    for (const f of data.files ?? []) {
      eventFiles.push(
        f.remote
          ? await this.remoteFile(data, f)
          : { name: TelegramInboxService.fileName(f), path: f.path, type: f.type, caption: f.caption ?? null },
      );
    }
    const afterState = {
      message: data.text ?? '',
      files: eventFiles,
      from_user_id: fromUser.id,
      to_user_id: toUser.id,
      outgoing: data.outgoing,
      contact: data.contact ?? null,
      location: data.location ?? null,
    };
    const date = data.date ? new Date(data.date) : null;

    const event = EventBuilder.fromType(EventTypes.NEW_TELEGRAM_MESSAGE)
      .originatedBy(fromUser)
      .addTargetUser(toUser)
      .linkToDeal(deal)
      .addAfterState(afterState)
      .addCreatedAt(date && !isNaN(date.getTime()) ? date : null);
    event.outgoing = data.outgoing;
    event.tg_message_id = data.tg_message_id;
    let saved: Event;
    try {
      saved = await this.eventRepository.save(event);
    } catch (error) {
      // stored meanwhile by another delivery (another API process): the unique key says so
      if (!isUniqueViolation(error)) throw error;
      return TelegramInboxService.duplicate(await this.stored(data.tg_message_id, agent.id, contact.id), contact.id, createdContact);
    }
    const files = await this.saveFiles(data, fromUser, [deal]);

    // triggers that wait for a Telegram message ("при входящем сообщении")
    await this.triggerService.onDealEvent(fromUser, deal, ApplyTriggerWhenEnum.TG_MESSAGE_RECEIVED, {
      outgoing: data.outgoing,
      from_user_id: fromUser.id,
    });
    if (choice.afterClose) await this.clientDeals.noteAfterClose(deal, 'Telegram');
    this.logger.log(
      `telegram message ${data.tg_message_id} of user ${agent.id} -> contact ${contact.id}, deal ${deal.id}${choice.afterClose ? ' (closed recently)' : ''}${files.length ? `, files ${files.length}` : ''}`,
    );

    return {
      status: 'saved',
      contact_id: contact.id,
      deal_ids: [deal.id],
      event_ids: [saved.id],
      created_contact: createdContact,
      created_deal: choice.created,
    };
  }

  /** The events of a Telegram message by its key (account, chat, message id): one, or none. */
  private async stored(tgMessageId: number, agentId: number, contactId: number): Promise<{ id: number; deal_id: number | null }[]> {
    return this.eventRepository.query(
      `SELECT id, deal_id FROM event
        WHERE type = ${EventTypes.NEW_TELEGRAM_MESSAGE} AND tg_message_id IS NOT NULL AND ${ACCOUNT_SQL} = $1 AND ${CHAT_SQL} = $2 AND tg_message_id = $3
        ORDER BY id`,
      [agentId, contactId, tgMessageId],
    );
  }

  static duplicate(already: { id: number; deal_id: number | null }[], contactId: number, createdContact: boolean): InboxResult {
    return {
      status: 'duplicate',
      contact_id: contactId,
      deal_ids: [...new Set(already.map((e) => e.deal_id).filter((id): id is number => Boolean(id)))],
      event_ids: already.map((e) => e.id),
      created_contact: createdContact,
      created_deal: false,
    };
  }

  /** A message edited in Telegram: the history shows the new text (the first one is kept as original_message). */
  private async applyEdit(already: { id: number }[], data: IncomingMessageDto, contact: User): Promise<InboxResult> {
    const events = await this.eventRepository.find({ where: { id: In(already.map((e) => e.id)) }, relations: { deal: true } });
    const text = data.text ?? '';
    const changed: Event[] = [];
    for (const event of events) {
      const state = { ...(event.after_state ?? {}) };
      if (state.message === text) continue;
      if (state.original_message === undefined) state.original_message = state.message ?? '';
      state.message = text;
      state.edited = true;
      state.edited_at = new Date().toISOString();
      event.after_state = state;
      changed.push(event);
    }
    if (changed.length) await this.eventRepository.save(changed);
    return {
      status: changed.length ? 'updated' : 'duplicate',
      contact_id: contact.id,
      deal_ids: [...new Set(events.map((e) => e.deal?.id).filter((id): id is number => Boolean(id)))],
      event_ids: events.map((e) => e.id),
      created_contact: false,
      created_deal: false,
    };
  }

  /** A file without a name (a phone video often has none) gets one by its kind. */
  static fileName(f: Pick<IncomingFileDto, 'name' | 'type'>): string {
    const name = String(f.name ?? '').trim();
    if (name) return name;
    return ({ video: 'Видео', video_note: 'Видеосообщение', voice: 'Голосовое сообщение', audio: 'Аудио', photo: 'Фото', sticker: 'Стикер', animation: 'GIF' } as Record<string, string>)[f.type] ?? 'Файл';
  }

  private async findContact(tgId: number, phone?: string): Promise<User | null> {
    const byTg = await this.userRepository.findOne({
      where: { tg_id: tgId, role: RoleEnum.CTR_AGENT },
      order: { id: 'ASC' },
    });
    if (byTg) return byTg;

    const key = keyOf(phone);
    if (!key) return null;
    // phones in the CRM are typed by hand ('+998 90 …', '90 123 45 67'): the last 9 digits, an exact number first
    const digits = String(phone ?? '').replace(/\D/g, '');
    return this.userRepository
      .createQueryBuilder('u')
      .where('u.role = :role', { role: RoleEnum.CTR_AGENT })
      .andWhere(`${PHONE_KEY_SQL('u.phone')} = :key`, { key })
      .orderBy(`(regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = :digits)`, 'DESC')
      .addOrderBy('u.id', 'ASC')
      .setParameter('digits', digits)
      .getOne();
  }

  private async createContact(agent: User, data: IncomingMessageDto): Promise<User> {
    const name = [data.chat.first_name, data.chat.last_name]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(' ');
    const contact = new User();
    contact.username = name || (data.chat.username ? '@' + data.chat.username : `Telegram ${data.chat.tg_id}`);
    contact.role = RoleEnum.CTR_AGENT;
    contact.tg_id = data.chat.tg_id;
    contact.phone = normalizePhone(data.chat.phone);
    contact.avatar = data.chat.photo || null;
    contact.created_by = agent;
    // no company and no required custom fields: a chat gives neither; the
    // manager completes the card in the CRM (same as the bot's company cards)
    return this.userRepository.save(contact);
  }

  /**
   * A file the service did not download because of its size (or could not download): the event gets
   * a link instead of a path (`url`, which the feed shows under the file's name), and telegram_remote_file
   * remembers where the file is, so GET /telegram/remote-file/:token can fetch it when somebody clicks.
   */
  private async remoteFile(data: IncomingMessageDto, f: IncomingFileDto) {
    const name = TelegramInboxService.fileName(f);
    const rows = await this.eventRepository.query(
      `INSERT INTO telegram_remote_file (token, agent_id, chat_tg_id, tg_message_id, name, kind, size, mime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, chat_tg_id, tg_message_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING token`,
      [randomBytes(16).toString('hex'), data.agent_id, data.chat.tg_id, data.tg_message_id,
        name.slice(0, 255), f.type, f.size ?? null, f.mime ?? null],
    );
    const base = (process.env.CRM_PUBLIC_URL || '').replace(/\/+$/, '');
    const mb = f.size ? Math.max(1, Math.round(f.size / 1048576)) : null;
    return {
      name: `${name} — ${mb ? `${mb} МБ, ` : ''}скачать из Telegram`,
      path: '',
      type: 'link',
      caption: f.caption ?? null,
      url: `${base}/api/v1/telegram/remote-file/${rows[0].token}`,
      remote: true,
      size: f.size ?? null,
      original_type: f.type,
    };
  }

  private async saveFiles(data: IncomingMessageDto, uploadedBy: User, deals: Deal[]): Promise<File[]> {
    const local = (data.files ?? []).filter((f) => !f.remote && f.path);
    if (!local.length) return [];
    const files = local.map((f) => {
      const file = new File();
      file.name = TelegramInboxService.fileName(f);
      file.path = f.path;
      file.extension = extname(f.path) || extname(file.name) || null;
      // the «Размер» of the files list (was 0 for every file of a message)
      file.size = FileService.sizeOnDisk(f.path, (f as { size?: number | null }).size);
      file.from = WhichFiles.FROM_MESSAGES;
      file.uploaded_by = uploadedBy;
      file.deals = deals;
      return file;
    });
    return this.fileRepository.save(files);
  }
}
