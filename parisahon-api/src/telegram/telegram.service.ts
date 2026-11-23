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
import * as process from 'process';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { SendCodeDto } from './dto/send.code.dto';
import { HelperService } from '../helper/helper.service';
import { RoleEnum, User } from '../user/user.entity';
import { StartSessionDto } from './dto/start.session.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Files, MediaTypes, SendMessageDto } from './dto/send.message.dto';
import { AuthUser } from '../auth/auth.guard';
import { TelegramInboxService } from './telegram-inbox.service';
import { ClientDealsService } from '../messenger/client-deals.service';
import { MessengerHealthService, ServiceSession } from '../messenger/messenger-health.service';
import {
  callService,
  ServiceUnreachable,
  telegramServiceConfigured,
  telegramServiceHeaders,
  telegramServiceUrl,
} from '../messenger/messenger-services';
import { normalizePhone } from '../helper/phone';
import { Deal } from '../deal/deal.entity';

interface SentPart {
  tg_message_id: number;
  file?: { name?: string; path?: string; type?: string; caption?: string | null } | null;
}

interface TelegramServiceResponse {
  message: string;
  needs_password?: boolean;
  // new service: what was actually delivered, in sending order
  sent?: SentPart[];
  // the connected account (POST /activate-auth)
  tg_id?: number;
  phone?: string;
  pending?: boolean;
}

const STAFF = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/** '+998901234567' -> '+998 ** *** 45 67': enough for the manager to recognise the number. */
export function maskPhone(phone?: string | null): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return phone ? '***' : '';
  return `+${digits.slice(0, digits.length - 9)} ** *** ${digits.slice(-4, -2)} ${digits.slice(-2)}`.replace('+ ', '+');
}

/**
 * Bridge to parisahon-telegram-service (Flask + Pyrogram, the managers' own
 * Telegram accounts).
 *
 *  - connecting an account: the Telegram application keys come from the API
 *    environment (TELEGRAM_API_ID / TELEGRAM_API_HASH), never from the browser;
 *  - a user connects, disconnects and writes only from their own account (an admin may
 *    connect or disconnect another staff account);
 *  - the sessions come with their state (connected / error / revoked in Telegram), so a dead
 *    account is visible (MessengerHealthService also tells the manager in the CRM bot);
 *  - a message sent from the CRM is recorded in the deal it was written from, after the
 *    service confirmed delivery (TelegramInboxService, the same path as incoming messages);
 *    parts that went out before a failure are recorded too, and a message the service is still
 *    sending when the wait is over is recorded by the service itself when it is out;
 *  - request_id makes a repeated click safe: the service does not send the same request twice;
 *  - every call carries the service token (messenger-services.ts); the service being down answers 503.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private helperService: HelperService,
    private inbox: TelegramInboxService,
    private clientDeals: ClientDealsService,
  ) {}

  /** The users with a stored Telegram session, each with `telegram` = the state of the session. */
  async fetchActiveSessions(): Promise<User[]> {
    const sessions = (await this.call('GET', '/get-sessions')) as unknown as ServiceSession[];
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return [];
    }
    const user_ids = sessions.map((session) => Number(session.user_id)).filter(Number.isInteger);
    const users = await this.userRepository.findBy({ id: In(user_ids) });
    for (const user of users) {
      const session = sessions.find((s) => Number(s.user_id) === user.id);
      Object.assign(user, {
        telegram: {
          ...MessengerHealthService.describe('telegram', session),
          account: session?.username ? '@' + session.username : session?.phone ?? null,
          last_message_at: session?.last_message_at ?? null,
        },
      });
    }
    return users;
  }

  async sendCode(request: Request, data: SendCodeDto): Promise<TelegramServiceResponse> {
    const user = await this.accountOf(request, data.user_id);
    const phone = normalizePhone(user.phone);
    if (!phone) {
      throw new BadRequestException('У пользователя не указан номер телефона (Профиль): на него Telegram пришлёт код');
    }
    const api_id = Number(process.env.TELEGRAM_API_ID);
    const api_hash = (process.env.TELEGRAM_API_HASH || '').trim();
    if (!api_id || !api_hash) {
      throw new ServiceUnavailableException(
        'Подключение Telegram не настроено: нет TELEGRAM_API_ID / TELEGRAM_API_HASH на сервере',
      );
    }
    const answer = await this.call('POST', '/send-code', {
      user_id: user.id,
      session: this.create_session_from_id(user.id),
      phone,
      api_id,
      api_hash,
    });
    return { ...answer, phone: maskPhone(phone) };
  }

  async activateAuth(request: Request, data: StartSessionDto): Promise<TelegramServiceResponse> {
    const user = await this.accountOf(request, data.user_id);
    const answer = await this.call('POST', '/activate-auth', {
      session: this.create_session_from_id(user.id),
      code: data.code,
      password: data.password ?? null,
    });
    // the connected account is the manager's own: their chats with themselves are never a client
    const tgId = Number(answer?.tg_id);
    if (tgId > 0 && Number(user.tg_id) !== tgId) {
      await this.userRepository.update(user.id, { tg_id: tgId });
    }
    this.logger.log(`telegram of user ${user.id} connected by user ${this.requester(request).sub}`);
    return answer;
  }

  /** «Отключить»: the service signs out of Telegram (the device disappears in Telegram → Devices) and forgets the session. */
  async disconnect(request: Request, userId?: number): Promise<{ status: string }> {
    const user = await this.accountOf(request, userId, true);
    await this.call('POST', '/logout', { user_id: user.id });
    this.logger.log(`telegram of user ${user.id} disconnected by user ${this.requester(request).sub}`);
    return { status: 'none' };
  }

  async sendMessage(
    request: Request,
    data: SendMessageDto,
    files: Array<Express.Multer.File>,
  ): Promise<Record<string, any>> {
    const me = this.requester(request);
    const from_user = Number(data.from_user);
    if (from_user !== me.sub) {
      throw new ForbiddenException('Писать в Telegram можно только от своего имени');
    }
    const prepared = await this.createSendMessageData(me, data, files);
    const request_id = String(data.request_id || '').trim().slice(0, 64) || randomUUID();
    const body = {
      from_user,
      to_user: prepared.to_user,
      to_phone: prepared.to_phone,
      message: prepared.message,
      files: prepared.files,
      deal_id: prepared.deal?.id ?? null,
      request_id,
    };

    let answer: { status: number; payload: any };
    try {
      answer = await this.request('POST', '/new-message', body, 90_000);
    } catch (error) {
      if (error instanceof ServiceUnreachable && error.message === 'timeout') return this.pending(request_id);
      throw error;
    }
    const payload: TelegramServiceResponse = answer.payload ?? { message: '' };
    const sent = Array.isArray(payload.sent) ? payload.sent : [];
    // the service gave up waiting, the message is still on its way: the service records it when it is out
    if (answer.status === 504 || payload.pending) return this.pending(request_id);

    if (answer.status < 300) {
      if (!sent.length) return { ...payload, request_id };
      const saved = await this.record(me, prepared, sent);
      return { ...payload, ...saved, request_id };
    }
    if (sent.length) {
      // a part went out before Telegram refused the rest: the history shows what the client got
      await this.record(me, prepared, sent);
      const total = prepared.files.length + (prepared.message ? 1 : 0);
      throw new HttpException(
        { message: `Отправлено частично (${sent.length} из ${total}): ${payload.message || 'Telegram не принял остальное'}`, sent: sent.length, request_id },
        HttpStatus.BAD_GATEWAY,
      );
    }
    throw this.failure(answer.status, payload);
  }

  private pending(request_id: string) {
    return {
      message: 'Telegram ещё отправляет сообщение: оно появится в истории сделки, когда Telegram его примет. Не отправляйте его ещё раз.',
      pending: true,
      request_id,
    };
  }

  /** The sent parts into the history of the deal it was written from (one event, the last message id). */
  private async record(me: AuthUser, prepared: PreparedMessage, sent: SentPart[]) {
    const last = sent[sent.length - 1];
    const textSent = sent.some((s) => !s.file);
    const sentFiles = sent
      .filter((s) => s.file)
      .map((s) => {
        const original = prepared.files.find((f) => f.path && s.file?.path && s.file.path.endsWith(f.path));
        return {
          name: original?.name ?? s.file?.name ?? 'Файл',
          path: original?.path ?? String(s.file?.path ?? '').split('/').pop() ?? '',
          type: original?.media_type ?? s.file?.type ?? 'document',
          caption: original?.caption ?? s.file?.caption ?? '',
        };
      });
    return this.inbox.receive(
      {
        agent_id: me.sub,
        chat: { tg_id: prepared.to_user },
        tg_message_id: Number(last.tg_message_id),
        text: textSent ? prepared.message : '',
        outgoing: true,
        files: sentFiles,
        deal_id: prepared.deal?.id ?? undefined,
      },
      { contact: prepared.contact },
    );
  }

  // ------------------------------------------------------------------ access

  private requester(request: Request): AuthUser {
    const user = request['user'] as AuthUser | undefined;
    if (!user?.sub) throw new ForbiddenException();
    return user;
  }

  /** The staff account to connect: the requester's own, another one only for an admin (also a deleted one, to disconnect it). */
  private async accountOf(request: Request, user_id?: number, withDeleted = false): Promise<User> {
    const me = this.requester(request);
    const id = Number(user_id) || me.sub;
    if (id !== me.sub && me.role !== RoleEnum.ADMIN) {
      throw new ForbiddenException('Подключить или отключить можно только свой Telegram');
    }
    if (withDeleted && id !== me.sub) {
      const user = await this.userRepository.findOne({ where: { id }, withDeleted: true });
      if (!user) throw new NotFoundException(`User with id ${id} does not exist!`);
      return user;
    }
    const user = await this.helperService.getById(User, id);
    if (!STAFF.includes(user.role)) {
      throw new BadRequestException(`User with id ${id} is not a staff account`);
    }
    return user;
  }

  // ------------------------------------------------------------------ service

  private async request(method: 'GET' | 'POST', path: string, body?: any, timeoutMs = 90_000): Promise<{ status: number; payload: any }> {
    if (!telegramServiceConfigured()) {
      throw new ServiceUnavailableException('Telegram-сервис не подключён к этой копии CRM');
    }
    try {
      return await callService(`${telegramServiceUrl()}${path}`, method, telegramServiceHeaders(), body, timeoutMs);
    } catch (error) {
      if (error instanceof ServiceUnreachable && error.message === 'timeout' && path === '/new-message') throw error;
      this.logger.warn(`telegram service ${path}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Telegram-сервис недоступен');
    }
  }

  private failure(status: number, payload: any): HttpException {
    const message = payload?.message || `Telegram-сервис ответил ${status}`;
    if (status === 401 || status === 403) {
      this.logger.error(`telegram service refused the API (${status}): TELEGRAM_SERVICE_TOKEN of the API and CRM_API_TOKEN of the service differ`);
      return new ServiceUnavailableException('Telegram-сервис отказал CRM в доступе: проверьте общий токен на сервере');
    }
    if (status >= 500) return new ServiceUnavailableException(message);
    return new BadRequestException({ message, needs_password: payload?.needs_password === true, retry: payload?.retry === true });
  }

  private async call(method: 'GET' | 'POST', path: string, body?: any): Promise<TelegramServiceResponse> {
    const { status, payload } = await this.request(method, path, body);
    if (status >= 300) throw this.failure(status, payload);
    return payload ?? { message: '' };
  }

  private async createSendMessageData(me: AuthUser, data: SendMessageDto, files: Array<Express.Multer.File>): Promise<PreparedMessage> {
    const from_user = Number(data.from_user);
    const to_user = Number(data.to_user);
    if (!Number.isInteger(to_user) || to_user <= 0) {
      throw new BadRequestException('Выберите контакт клиента');
    }

    const users = await this.userRepository.find({
      where: { id: In([from_user, to_user]) },
    });
    const usersMap = this.helperService.createHashMap<User>(users);
    const agent = usersMap.get(from_user);
    const ctr_agent = usersMap.get(to_user);
    if (!agent || !ctr_agent) {
      throw new NotFoundException(
        `User with id ${agent ? to_user : from_user} does not exist!`,
      );
    }
    if (!STAFF.includes(agent.role) || ctr_agent.role !== RoleEnum.CTR_AGENT) {
      throw new BadRequestException('Писать можно только контакту клиента');
    }
    if (!ctr_agent.tg_id) {
      throw new BadRequestException('У контакта нет Telegram: он ещё не писал менеджеру');
    }
    const message = String(data.message ?? '');
    if (!message.trim() && files.length === 0) {
      throw new BadRequestException('Пустое сообщение: напишите текст или приложите файл');
    }
    // whether the manager's own Telegram works is the service's answer (a stored tg_id says nothing)

    const { deals, deal } = await this.clientDeals.writableDeal(me, ctr_agent.id, data.deal_id ? Number(data.deal_id) : null);
    if (deals.length === 0) {
      throw new BadRequestException('У вас нет открытой сделки с этим контактом');
    }
    if (data.deal_id && !deal) {
      throw new BadRequestException('Из этой сделки написать нельзя: она закрыта или вам недоступна');
    }

    return {
      contact: ctr_agent,
      to_user: Number(ctr_agent.tg_id),
      to_phone: normalizePhone(ctr_agent.phone),
      message,
      files: this.createFilesArray(files),
      deal,
    };
  }

  private createFilesArray(files: Array<Express.Multer.File>): Files[] {
    return files.map((file) => ({
      name: file.originalname,
      path: file.filename,
      media_type: this.getMediaType(file.originalname.toLowerCase()),
      caption: '',
    }));
  }

  private getMediaType(filename: string): MediaTypes {
    const extension = this.getFileExtension(filename);

    if (filename.includes(MediaTypes.VOICE) && extension == '.mp3') {
      return MediaTypes.VOICE;
    }
    if (filename.includes(MediaTypes.DOCUMENT)) {
      return MediaTypes.DOCUMENT;
    }
    if (filename.includes(MediaTypes.PHOTO) && ['.jpg', '.jpeg', '.png'].includes(extension)) {
      return MediaTypes.PHOTO;
    }
    if (filename.includes(MediaTypes.AUDIO) && extension == '.mp3') {
      return MediaTypes.AUDIO;
    }
    if (filename.includes(MediaTypes.VIDEO) && ['.mp4', '.mov'].includes(extension)) {
      return MediaTypes.VIDEO;
    }

    switch (extension) {
      case '.mp3':
      case '.wav':
        return MediaTypes.AUDIO;
      case '.jpg':
      case '.jpeg':
      case '.png':
        return MediaTypes.PHOTO;
      case '.mp4':
      case '.mov':
        return MediaTypes.VIDEO;
      default:
        return MediaTypes.DOCUMENT;
    }
  }

  private getFileExtension(filename: string): string {
    const lastDotIndex = filename.lastIndexOf('.');
    if (lastDotIndex <= 0 || lastDotIndex === filename.length - 1) {
      return '.txt';
    }
    return filename.substring(lastDotIndex);
  }

  private create_session_from_id(id: number): string {
    return `session_${id}`;
  }
}

interface PreparedMessage {
  contact: User;
  to_user: number;
  to_phone: string | null;
  message: string;
  files: Files[];
  deal: Deal | null;
}
