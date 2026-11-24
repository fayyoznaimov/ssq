import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { AuthUser } from '../auth/auth.guard';
import { RoleEnum, User } from '../user/user.entity';
import { ClientDealsService } from '../messenger/client-deals.service';
import { MessengerHealthService, ServiceSession } from '../messenger/messenger-health.service';
import { callService, ServiceUnreachable, whatsappServiceConfigured, whatsappServiceHeaders, whatsappServiceUrl } from '../messenger/messenger-services';
import { normalizePhone } from '../helper/phone';
import { AuditJournal } from '../audit/audit-journal';
import { WhatsAppInboxService } from './whatsapp-inbox.service';
import { SendWhatsAppDto } from './dto/send.whatsapp.dto';

export interface WhatsAppState {
  status: 'none' | 'starting' | 'qr' | 'code' | 'connected' | 'logged_out' | 'error';
  qr?: string;
  // linking by phone number: the 8-character code to type on the phone
  code?: string;
  phone?: string;
  name?: string;
  // a linked number that lost the connection: since when, how many attempts, the last error
  linked?: boolean;
  since?: string;
  reconnects?: number;
  error?: string;
  passkey?: boolean;
}

const STAFF = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/**
 * Bridge to parisahon-whatsapp-service (Baileys, the managers' own WhatsApp
 * numbers, connected by scanning a QR code like WhatsApp Web):
 *  - a user connects / disconnects only their own WhatsApp (an admin: anyone's, also a deleted user's);
 *  - a message from a deal goes to a client contact of an open deal of the user and is written into
 *    THAT deal for THAT contact after WhatsApp accepted it (WA-7): the known chat (wa_id) is used first,
 *    a local number gets the country code (WA-6); parts sent before a failure are recorded too, and a
 *    send the API stopped waiting for is recorded by the service when it is out (WA-12);
 *  - request_id makes a repeated click safe: the service does not send the same request twice;
 *  - WHATSAPP_SERVICE_URL + WHATSAPP_SERVICE_TOKEN; without them 503.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    @InjectRepository(User) private userRepository: Repository<User>,
    private inbox: WhatsAppInboxService,
    private clientDeals: ClientDealsService,
  ) {}

  async state(me: AuthUser, userId?: number): Promise<WhatsAppState> {
    const id = await this.accountId(me, userId);
    return this.call('GET', `/sessions/${id}`);
  }

  /**
   * Without a phone: a QR code to scan. With a phone: a code to type on that phone
   * (WhatsApp → Связанные устройства → Привязать по номеру телефона) — for accounts
   * where the QR route stops at the passkey / fingerprint step. A linked number that is
   * reconnecting is reconnected at once.
   */
  async connect(me: AuthUser, userId?: number, phone?: string): Promise<WhatsAppState> {
    const id = await this.accountId(me, userId);
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (phone !== undefined && phone !== null && phone !== '' && (digits.length < 9 || digits.length > 15)) {
      throw new BadRequestException('Номер телефона: от 9 до 15 цифр с кодом страны');
    }
    // a local number from the profile ('90 123 45 67') gets the country code
    const full = digits ? normalizePhone(phone) : null;
    const state = await this.call<WhatsAppState>('POST', `/sessions/${id}/start`, digits ? { phone: full && full.startsWith('+') ? full : '+' + digits } : {});
    // the journal (src/audit, WA-16): who started connecting whose WhatsApp
    await AuditJournal.record(this.userRepository.manager, {
      entity: 'messenger',
      entityId: id,
      action: 'insert',
      summary: `WhatsApp: подключение начато${digits ? ' по номеру' : ' по QR-коду'}`,
      meta: { channel: 'whatsapp', ...(digits ? { phone: full && full.startsWith('+') ? full : '+' + digits } : {}) },
    });
    return state;
  }

  async disconnect(me: AuthUser, userId?: number): Promise<WhatsAppState> {
    const id = await this.accountId(me, userId, true);
    this.logger.log(`whatsapp of user ${id} disconnected by user ${me.sub}`);
    const state = await this.call<WhatsAppState>('DELETE', `/sessions/${id}`);
    // the journal (src/audit, WA-16): who disconnected whose WhatsApp (an admin may disconnect another's)
    await AuditJournal.record(this.userRepository.manager, {
      entity: 'messenger',
      entityId: id,
      action: 'delete',
      summary: 'WhatsApp отключён',
      meta: { channel: 'whatsapp' },
    });
    return state;
  }

  /** Admin: every staff user with the state of their WhatsApp (also those who never connected it). */
  async sessions(): Promise<Record<string, any>[]> {
    const list = await this.call<ServiceSession[]>('GET', '/sessions');
    const sessions = Array.isArray(list) ? list : [];
    const staff = await this.userRepository.find({ where: { role: In(STAFF) }, order: { username: 'ASC' } });
    const ids = new Set(staff.map((u) => u.id));
    const extra = sessions.filter((s) => !ids.has(Number(s.user_id)));
    const rows = staff.map((u) => {
      const session = sessions.find((s) => Number(s.user_id) === u.id) ?? null;
      const health = MessengerHealthService.describe('whatsapp', session);
      return { ...(session ?? {}), user_id: u.id, username: u.username, status: session?.status ?? 'none', phone: session?.phone ?? null, text: health.text, state: health.state };
    });
    for (const s of extra) {
      const health = MessengerHealthService.describe('whatsapp', s);
      rows.push({ ...s, user_id: Number(s.user_id), username: `№${s.user_id} (не сотрудник)`, status: s.status, phone: s.phone ?? null, text: health.text, state: health.state });
    }
    return rows;
  }

  async send(me: AuthUser, data: SendWhatsAppDto, files: Express.Multer.File[]): Promise<Record<string, any>> {
    const contact = await this.userRepository.findOne({ where: { id: Number(data.to_user) } });
    if (!contact) throw new NotFoundException(`User with id ${data.to_user} does not exist!`);
    if (contact.role !== RoleEnum.CTR_AGENT) throw new BadRequestException('Писать можно только контакту клиента');
    const phone = normalizePhone(contact.phone);
    const toPhone = phone && phone.startsWith('+') ? phone : null;
    if (!toPhone && !contact.wa_id) throw new BadRequestException('У контакта нет номера телефона для WhatsApp');
    const { deals, deal } = await this.clientDeals.writableDeal(me, contact.id, data.deal_id ? Number(data.deal_id) : null);
    if (!deals.length) throw new BadRequestException('У вас нет открытой сделки с этим контактом');
    if (data.deal_id && !deal) throw new BadRequestException('Из этой сделки написать нельзя: она закрыта или вам недоступна');
    const text = data.message ?? '';
    if (!text.trim() && !files.length) throw new BadRequestException('Пустое сообщение: напишите текст или приложите файл');

    const outFiles = files.map((f) => ({ name: f.originalname, path: f.filename, type: WhatsAppService.typeOf(f.originalname, f.mimetype) }));
    const request_id = String(data.request_id || '').trim().slice(0, 64) || randomUUID();
    const body = {
      user_id: me.sub,
      // the chat WhatsApp already knows is used first; the number only when there is no chat yet
      to_phone: toPhone,
      to_wa_id: contact.wa_id || null,
      text,
      files: outFiles,
      request_id,
      deal_id: deal?.id ?? null,
      contact_id: contact.id,
    };
    let answer: { status: number; payload: any };
    try {
      answer = await this.request('POST', '/send', body, 120_000);
    } catch (error) {
      if (error instanceof ServiceUnreachable && error.message === 'timeout') return this.pending(request_id);
      this.logger.warn(`whatsapp service POST /send: ${(error as Error).message}`);
      throw new ServiceUnavailableException('WhatsApp-сервис недоступен');
    }
    const payload = answer.payload ?? {};
    const ids: string[] = Array.isArray(payload.message_ids) ? payload.message_ids : [];
    if (payload.pending) return this.pending(request_id);
    if (answer.status < 300) {
      const saved = ids.length ? await this.record(me, contact, deal?.id ?? null, ids, text, outFiles) : null;
      return { message_ids: ids, request_id, ...(saved ?? {}) };
    }
    if (ids.length) {
      // files go first, then the text: what went out before WhatsApp refused the rest
      await this.record(me, contact, deal?.id ?? null, ids, ids.length > outFiles.length ? text : '', outFiles.slice(0, ids.length));
      const total = outFiles.length + (text.trim() ? 1 : 0);
      throw new HttpException(
        { message: `Отправлено частично (${ids.length} из ${total}): ${payload.message || 'WhatsApp не принял остальное'}`, message_ids: ids, request_id },
        HttpStatus.BAD_GATEWAY,
      );
    }
    throw this.failure(answer.status, payload);
  }

  private pending(request_id: string) {
    return {
      message: 'WhatsApp ещё отправляет сообщение: оно появится в истории сделки, когда WhatsApp его примет. Не отправляйте его ещё раз.',
      pending: true,
      message_ids: [],
      request_id,
    };
  }

  private async record(me: AuthUser, contact: User, dealId: number | null, ids: string[], text: string, files: { name: string; path: string; type: string }[]) {
    return this.inbox.receive(
      {
        agent_id: me.sub,
        chat: { wa_id: contact.wa_id || `${String(contact.phone ?? '').replace(/\D/g, '')}@s.whatsapp.net`, phone: contact.phone },
        wa_message_id: ids[ids.length - 1],
        text,
        outgoing: true,
        files,
        deal_id: dealId ?? undefined,
      },
      { contact },
    );
  }

  static typeOf(name: string, mime = ''): string {
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'photo';
    if (mime.startsWith('video/') || ['mp4', 'mov'].includes(ext)) return 'video';
    if (mime.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) return 'audio';
    return 'document';
  }

  // ------------------------------------------------------------------ access

  /** The requester's account, another staff user's only for an admin (a deleted one too, to disconnect it). */
  private async accountId(me: AuthUser, userId?: number, withDeleted = false): Promise<number> {
    const id = Number(userId) || me.sub;
    if (id !== me.sub && me.role !== RoleEnum.ADMIN) {
      throw new ForbiddenException('Подключить или отключить можно только свой WhatsApp');
    }
    if (id !== me.sub) {
      const user = await this.userRepository.findOne({ where: { id }, withDeleted });
      if (!user) throw new NotFoundException(`User with id ${id} does not exist!`);
      if (!user.deleted_at && !STAFF.includes(user.role)) throw new BadRequestException('Это не сотрудник');
    }
    return id;
  }

  // ------------------------------------------------------------------ service

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: any, timeoutMs = 60_000): Promise<{ status: number; payload: any }> {
    if (!whatsappServiceConfigured()) throw new ServiceUnavailableException('WhatsApp-сервис не подключён к этой копии CRM');
    return callService(whatsappServiceUrl() + path, method, whatsappServiceHeaders(), body, timeoutMs);
  }

  private failure(status: number, payload: any): HttpException {
    const message = payload?.message || payload?.error || `WhatsApp-сервис ответил ${status}`;
    if (status === 401) {
      this.logger.error('whatsapp service refused the API (401): WHATSAPP_SERVICE_TOKEN of the API and CRM_API_TOKEN of the service differ');
      return new ServiceUnavailableException('WhatsApp-сервис отказал CRM в доступе: проверьте общий токен на сервере');
    }
    if (status >= 500) return new ServiceUnavailableException(message);
    return new BadRequestException(message);
  }

  private async call<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: any): Promise<T> {
    let answer: { status: number; payload: any };
    try {
      answer = await this.request(method, path, body);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`whatsapp service ${method} ${path}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('WhatsApp-сервис недоступен');
    }
    if (answer.status >= 300) throw this.failure(answer.status, answer.payload);
    return answer.payload as T;
  }
}
