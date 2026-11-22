import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { extname } from 'path';
import { randomBytes } from 'crypto';
import { RoleEnum, User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event, EventTypes } from '../events/event.entity';
import { EventBuilder } from '../events/event.builder';
import { File } from '../file/file.entity';
import { WhichFiles } from '../trigger/dto/assign.trigger.dto';
import { TriggerService } from '../trigger/trigger.service';
import { ApplyTriggerWhenEnum } from '../trigger/dto/assign.trigger.dto';
import { IncomingFileDto, IncomingMessageDto } from './dto/incoming.message.dto';
import { MessengerLookupService } from '../messenger/messenger-lookup.service';
import { ClientDealsService } from '../messenger/client-deals.service';

export interface InboxResult {
  status: 'saved' | 'duplicate' | 'ignored';
  reason?: string;
  contact_id?: number;
  deal_ids: number[];
  event_ids: number[];
  created_contact: boolean;
  created_deal: boolean;
}

/**
 * Where a Telegram message of a manager's chat becomes CRM data.
 *
 * Before, parisahon-telegram-service wrote the contact, the deal and the
 * event straight into Postgres, so triggers of the stage and the events the
 * API emits never happened. Now the service posts the message here
 * (POST /telegram/incoming) and the CRM's own services do the writing:
 *  - the client is found by Telegram id, then by phone; otherwise a new
 *    contact (ctr_agent) is created without a company (TELEGRAM_KNOWN_CONTACTS_ONLY=true:
 *    chats with people who are not in the CRM are ignored instead);
 *  - the message goes to every open deal of this manager with this client;
 *    without one, a deal is created in the default stage (DealService.create,
 *    so NEW_DEAL / NEW_CTR_AGENT events and the stage's triggers run);
 *  - the same Telegram message is never saved twice (tg_message_id per deal),
 *    so the service may retry after a failure.
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
  ) {}

  static knownContactsOnly(): boolean {
    return ['1', 'true', 'yes'].includes(
      String(process.env.TELEGRAM_KNOWN_CONTACTS_ONLY ?? '').toLowerCase(),
    );
  }

  /** "+998 90 123-45-67" -> "+998901234567"; null when there are no digits. */
  static normalizePhone(phone?: string | null): string | null {
    const digits = String(phone ?? '').replace(/[^\d]/g, '');
    return digits ? '+' + digits : null;
  }

  async receive(data: IncomingMessageDto): Promise<InboxResult> {
    const agent = await this.userRepository.findOne({
      where: { id: data.agent_id, role: In([RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT]) },
    });
    if (!agent) {
      throw new NotFoundException(`Staff user ${data.agent_id} does not exist`);
    }
    if (data.agent_tg_id && Number(agent.tg_id) !== Number(data.agent_tg_id)) {
      await this.userRepository.update(agent.id, { tg_id: data.agent_tg_id });
      agent.tg_id = data.agent_tg_id;
    }

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

    let contact = await this.findContact(data.chat.tg_id, data.chat.phone);
    let createdContact = false;
    if (!contact) {
      if (TelegramInboxService.knownContactsOnly()) {
        return { ...empty, reason: 'unknown_contact' };
      }
      contact = await this.createContact(agent, data);
      createdContact = true;
    } else {
      const patch: Partial<User> = {};
      if (!contact.tg_id) patch.tg_id = data.chat.tg_id;
      if (!contact.phone && data.chat.phone) patch.phone = TelegramInboxService.normalizePhone(data.chat.phone);
      if (data.chat.photo && data.chat.photo !== contact.avatar) patch.avatar = data.chat.photo;
      if (Object.keys(patch).length) {
        await this.userRepository.update(contact.id, patch);
        Object.assign(contact, patch);
      }
    }
    // the same number in WhatsApp, in the background
    if (contact.phone && !contact.wa_id && !data.outgoing) this.lookup.lookupLater(agent.id, contact.id);

    // the client's open deal (own first, else another manager's), else a new one (ClientDealsService)
    const { deals, created: createdDeal } = await this.clientDeals.dealsForMessage(agent, contact);

    // idempotent: a retry of the same Telegram message adds nothing
    const already = await this.eventRepository.find({
      select: { id: true, deal: { id: true } },
      where: {
        type: EventTypes.NEW_TELEGRAM_MESSAGE,
        tg_message_id: data.tg_message_id,
        outgoing: data.outgoing,
        deal: { id: In(deals.map((d) => d.id)) },
      },
      relations: { deal: true },
    });
    const doneDealIds = new Set(already.map((e) => e.deal.id));
    const targetDeals = deals.filter((d) => !doneDealIds.has(d.id));
    if (targetDeals.length === 0) {
      return {
        status: 'duplicate',
        contact_id: contact.id,
        deal_ids: deals.map((d) => d.id),
        event_ids: already.map((e) => e.id),
        created_contact: createdContact,
        created_deal: createdDeal,
      };
    }

    const fromUser = data.outgoing ? agent : contact;
    const toUser = data.outgoing ? contact : agent;
    const files = await this.saveFiles(data, fromUser, targetDeals);
    const eventFiles = [];
    for (const f of data.files ?? []) {
      eventFiles.push(
        f.remote
          ? await this.remoteFile(data, f)
          : { name: f.name, path: f.path, type: f.type, caption: f.caption ?? null },
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

    const events = targetDeals.map((deal) => {
      const event = EventBuilder.fromType(EventTypes.NEW_TELEGRAM_MESSAGE)
        .originatedBy(fromUser)
        .addTargetUser(toUser)
        .linkToDeal(deal)
        .addAfterState(afterState)
        .addCreatedAt(date && !isNaN(date.getTime()) ? date : null);
      event.outgoing = data.outgoing;
      event.tg_message_id = data.tg_message_id;
      return event;
    });
    const saved = await this.eventRepository.save(events);

    // triggers that wait for a Telegram message ("при входящем сообщении")
    for (const deal of targetDeals) {
      await this.triggerService.onDealEvent(fromUser, deal, ApplyTriggerWhenEnum.TG_MESSAGE_RECEIVED, {
        outgoing: data.outgoing,
        from_user_id: fromUser.id,
      });
    }
    this.logger.log(
      `telegram message ${data.tg_message_id} of user ${agent.id} -> contact ${contact.id}, deals ${targetDeals.map((d) => d.id).join(',')}${files.length ? `, files ${files.length}` : ''}`,
    );

    return {
      status: 'saved',
      contact_id: contact.id,
      deal_ids: deals.map((d) => d.id),
      event_ids: saved.map((e) => e.id),
      created_contact: createdContact,
      created_deal: createdDeal,
    };
  }

  private async findContact(tgId: number, phone?: string): Promise<User | null> {
    const byTg = await this.userRepository.findOne({
      where: { tg_id: tgId, role: RoleEnum.CTR_AGENT },
      order: { id: 'ASC' },
    });
    if (byTg) return byTg;

    const normalized = TelegramInboxService.normalizePhone(phone);
    if (!normalized) return null;
    // phones in the CRM are typed by hand: compare digits only
    return this.userRepository
      .createQueryBuilder('u')
      .where('u.role = :role', { role: RoleEnum.CTR_AGENT })
      .andWhere("regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = :digits", {
        digits: normalized.slice(1),
      })
      .orderBy('u.id', 'ASC')
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
    contact.phone = TelegramInboxService.normalizePhone(data.chat.phone);
    contact.avatar = data.chat.photo || null;
    contact.created_by = agent;
    // no company and no required custom fields: a chat gives neither; the
    // manager completes the card in the CRM (same as the bot's company cards)
    return this.userRepository.save(contact);
  }

  /**
   * A file the service did not download because of its size: the event gets a link instead of a
   * path (`url`, which the feed shows under the file's name), and telegram_remote_file remembers
   * where the file is, so GET /telegram/remote-file/:token can fetch it when somebody clicks.
   */
  private async remoteFile(data: IncomingMessageDto, f: IncomingFileDto) {
    const rows = await this.eventRepository.query(
      `INSERT INTO telegram_remote_file (token, agent_id, chat_tg_id, tg_message_id, name, kind, size, mime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, chat_tg_id, tg_message_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING token`,
      [randomBytes(16).toString('hex'), data.agent_id, data.chat.tg_id, data.tg_message_id,
        String(f.name || 'file').slice(0, 255), f.type, f.size ?? null, f.mime ?? null],
    );
    const base = (process.env.CRM_PUBLIC_URL || '').replace(/\/+$/, '');
    const mb = f.size ? Math.max(1, Math.round(f.size / 1048576)) : null;
    return {
      name: `${f.name} — ${mb ? `${mb} МБ, ` : ''}скачать из Telegram`,
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
