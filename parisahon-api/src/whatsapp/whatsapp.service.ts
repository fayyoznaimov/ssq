import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { RoleEnum, User } from '../user/user.entity';
import { ClientDealsService } from '../messenger/client-deals.service';
import { WhatsAppInboxService } from './whatsapp-inbox.service';
import { SendWhatsAppDto } from './dto/send.whatsapp.dto';

export interface WhatsAppState {
  status: 'none' | 'starting' | 'qr' | 'code' | 'connected' | 'logged_out';
  qr?: string;
  // linking by phone number: the 8-character code to type on the phone
  code?: string;
  phone?: string;
  name?: string;
}

const STAFF = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/**
 * Bridge to parisahon-whatsapp-service (Baileys, the managers' own WhatsApp
 * numbers, connected by scanning a QR code like WhatsApp Web):
 *  - a user connects / disconnects only their own WhatsApp (an admin: anyone's);
 *  - a message from a deal goes to a client contact of an open deal of the user,
 *    and is written to the history after WhatsApp accepted it (same path as incoming);
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
   * where the QR route stops at the passkey / fingerprint step.
   */
  async connect(me: AuthUser, userId?: number, phone?: string): Promise<WhatsAppState> {
    const id = await this.accountId(me, userId);
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (phone !== undefined && phone !== null && phone !== '' && (digits.length < 9 || digits.length > 15)) {
      throw new BadRequestException('Номер телефона: от 9 до 15 цифр с кодом страны');
    }
    return this.call('POST', `/sessions/${id}/start`, digits ? { phone: '+' + digits } : {});
  }

  async disconnect(me: AuthUser, userId?: number): Promise<WhatsAppState> {
    const id = await this.accountId(me, userId);
    return this.call('DELETE', `/sessions/${id}`);
  }

  async sessions(): Promise<{ user_id: number; status: string; phone?: string }[]> {
    return this.call('GET', '/sessions');
  }

  async send(me: AuthUser, data: SendWhatsAppDto, files: Express.Multer.File[]): Promise<Record<string, any>> {
    const contact = await this.userRepository.findOne({ where: { id: Number(data.to_user) } });
    if (!contact) throw new NotFoundException(`User with id ${data.to_user} does not exist!`);
    if (contact.role !== RoleEnum.CTR_AGENT) throw new BadRequestException('Писать можно только контакту клиента');
    if (!contact.phone && !contact.wa_id) throw new BadRequestException('У контакта нет номера телефона для WhatsApp');
    const writable = await this.clientDeals.writableDeals(me, contact.id);
    if (!writable.length) throw new BadRequestException('У вас нет открытой сделки с этим контактом');
    if (!(data.message ?? '').trim() && !files.length) throw new BadRequestException('Пустое сообщение');

    const outFiles = files.map((f) => ({ name: f.originalname, path: f.filename, type: WhatsAppService.typeOf(f.originalname, f.mimetype) }));
    const result = await this.call<{ message_ids: string[] }>('POST', '/send', {
      user_id: me.sub,
      to_phone: contact.phone || null,
      to_wa_id: contact.wa_id || null,
      text: data.message ?? '',
      files: outFiles,
    });
    const ids = result?.message_ids ?? [];
    const saved = await this.inbox.receive({
      agent_id: me.sub,
      chat: { wa_id: contact.wa_id || `${(contact.phone ?? '').replace(/\D/g, '')}@s.whatsapp.net`, phone: contact.phone },
      wa_message_id: ids[ids.length - 1] ?? `crm-${Date.now()}`,
      text: data.message ?? '',
      outgoing: true,
      files: outFiles,
    });
    return { message_ids: ids, ...saved };
  }

  static typeOf(name: string, mime = ''): string {
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'photo';
    if (mime.startsWith('video/') || ['mp4', 'mov'].includes(ext)) return 'video';
    if (mime.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) return 'audio';
    return 'document';
  }

  // ------------------------------------------------------------------ access

  private async accountId(me: AuthUser, userId?: number): Promise<number> {
    const id = Number(userId) || me.sub;
    if (id !== me.sub && me.role !== RoleEnum.ADMIN) {
      throw new ForbiddenException('Подключить можно только свой WhatsApp');
    }
    if (id !== me.sub) {
      const user = await this.userRepository.findOne({ where: { id } });
      if (!user) throw new NotFoundException(`User with id ${id} does not exist!`);
      if (!STAFF.includes(user.role)) throw new BadRequestException('Это не сотрудник');
    }
    return id;
  }

  // ------------------------------------------------------------------ service

  private async call<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: any): Promise<T> {
    const base = (process.env.WHATSAPP_SERVICE_URL ?? '').replace(/\/+$/, '');
    const token = process.env.WHATSAPP_SERVICE_TOKEN ?? '';
    if (!base || !token) throw new ServiceUnavailableException('WhatsApp-сервис не подключён к этой копии CRM');
    let response: Response;
    try {
      response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-WhatsApp-Service-Token': token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      this.logger.warn(`whatsapp service ${method} ${path}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('WhatsApp-сервис недоступен');
    }
    const payload: any = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.message || payload?.error || `WhatsApp-сервис ответил ${response.status}`;
      if (response.status >= 500 || response.status === 401) throw new ServiceUnavailableException(message);
      throw new BadRequestException(message);
    }
    return payload as T;
  }
}
