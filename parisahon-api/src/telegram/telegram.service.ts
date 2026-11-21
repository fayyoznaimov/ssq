import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as process from 'process';
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

interface TelegramSession {
  user_id: number;
  name: string;
}

interface TelegramServiceResponse {
  message: string;
  needs_password?: boolean;
  // new service: what was actually delivered, in sending order
  sent?: { tg_message_id: number; file?: string | null }[];
}

const STAFF = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/**
 * Bridge to parisahon-telegram-service (Flask + Pyrogram, the managers' own
 * Telegram accounts).
 *
 *  - connecting an account: the Telegram application keys come from the API
 *    environment (TELEGRAM_API_ID / TELEGRAM_API_HASH), never from the browser;
 *  - a user connects and writes only from their own account (an admin may
 *    connect another staff account for them);
 *  - a message sent from the CRM is recorded in the deal history here, after
 *    the service confirmed delivery (TelegramInboxService, the same path as
 *    incoming messages), so "в очереди" without a result is gone;
 *  - the service being down answers 503 instead of 500.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly telegram_service_url: string;

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private helperService: HelperService,
    private inbox: TelegramInboxService,
    private clientDeals: ClientDealsService,
  ) {
    const host = (process.env.TELEGRAM_SERVICE_HOST || '').replace(/\/+$/, '');
    const port = process.env.TELEGRAM_SERVICE_PORT;
    this.telegram_service_url =
      port && port !== '80' && !/:\d+$/.test(host) ? `${host}:${port}` : host;
  }

  async fetchActiveSessions(): Promise<User[]> {
    const sessions = (await this.call('GET', '/get-sessions')) as unknown as TelegramSession[];
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return [];
    }
    const user_ids = sessions.map((session) => Number(session.user_id)).filter(Number.isInteger);
    return this.userRepository.findBy({ id: In(user_ids) });
  }

  async sendCode(request: Request, data: SendCodeDto): Promise<TelegramServiceResponse> {
    const user = await this.accountOf(request, data.user_id);
    if (!user.phone) {
      throw new BadRequestException('У пользователя не указан номер телефона');
    }
    const api_id = Number(process.env.TELEGRAM_API_ID);
    const api_hash = (process.env.TELEGRAM_API_HASH || '').trim();
    if (!api_id || !api_hash) {
      throw new ServiceUnavailableException(
        'Подключение Telegram не настроено: нет TELEGRAM_API_ID / TELEGRAM_API_HASH на сервере',
      );
    }
    return this.call('POST', '/send-code', {
      user_id: user.id,
      session: this.create_session_from_id(user.id),
      phone: user.phone,
      api_id,
      api_hash,
    });
  }

  async activateAuth(request: Request, data: StartSessionDto): Promise<TelegramServiceResponse> {
    const user = await this.accountOf(request, data.user_id);
    return this.call('POST', '/activate-auth', {
      session: this.create_session_from_id(user.id),
      code: data.code,
      password: data.password ?? null,
    });
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
    const requestBody = await this.createSendMessageData(me, data, files);
    const result = await this.call('POST', '/new-message', requestBody);

    // The new service answers only after Telegram accepted the messages; the
    // history is written here. (An old service without `sent` wrote it itself.)
    if (Array.isArray(result.sent) && result.sent.length > 0) {
      const last = result.sent[result.sent.length - 1];
      const saved = await this.inbox.receive({
        agent_id: from_user,
        chat: { tg_id: requestBody.to_user },
        tg_message_id: Number(last.tg_message_id),
        text: data.message ?? '',
        outgoing: true,
        files: requestBody.files.map((f) => ({ name: f.name, path: f.path, type: f.media_type, caption: f.caption })),
      });
      return { ...result, ...saved };
    }
    return result;
  }

  // ------------------------------------------------------------------ access

  private requester(request: Request): AuthUser {
    const user = request['user'] as AuthUser | undefined;
    if (!user?.sub) throw new ForbiddenException();
    return user;
  }

  /** The staff account to connect: the requester's own, another one only for an admin. */
  private async accountOf(request: Request, user_id?: number): Promise<User> {
    const me = this.requester(request);
    const id = user_id ?? me.sub;
    if (id !== me.sub && me.role !== RoleEnum.ADMIN) {
      throw new ForbiddenException('Подключить можно только свой Telegram');
    }
    const user = await this.helperService.getById(User, id);
    if (!STAFF.includes(user.role)) {
      throw new BadRequestException(`User with id ${id} is not a staff account`);
    }
    return user;
  }

  // ------------------------------------------------------------------ service

  private async call(method: 'GET' | 'POST', path: string, body?: any): Promise<TelegramServiceResponse> {
    if (!this.telegram_service_url || /\.invalid(:|$)/.test(this.telegram_service_url)) {
      throw new ServiceUnavailableException('Telegram-сервис не подключён к этой копии CRM');
    }
    let response: Response;
    try {
      response = await fetch(`${this.telegram_service_url}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      this.logger.warn(`telegram service ${path}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Telegram-сервис недоступен');
    }
    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = payload?.message || `Telegram-сервис ответил ${response.status}`;
      if (response.status >= 500) throw new ServiceUnavailableException(message);
      throw new BadRequestException({ message, needs_password: payload?.needs_password === true });
    }
    return payload ?? { message: '' };
  }

  private async createSendMessageData(
    me: AuthUser,
    data: SendMessageDto,
    files: Array<Express.Multer.File>,
  ): Promise<{ from_user: number; to_user: number; message: string; files: Files[]; deal_ids: number[] }> {
    const from_user = Number(data.from_user);
    const to_user = Number(data.to_user);

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
    if (!agent.tg_id) {
      throw new BadRequestException('Ваш Telegram не подключён (Telegram → Подключить)');
    }

    const deals = await this.clientDeals.writableDeals(me, ctr_agent.id);
    if (deals.length === 0) {
      throw new BadRequestException('У вас нет открытой сделки с этим контактом');
    }

    return {
      from_user,
      to_user: Number(ctr_agent.tg_id),
      message: data.message ?? '',
      files: this.createFilesArray(files),
      deal_ids: deals.map((deal) => deal.id),
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
