import {
  HttpException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { createHash, randomBytes } from 'node:crypto';
import { RecognitionService } from '../recognition/recognition.service';
import { BotAccess, loadStaffUser } from './bot-access';
import { BotAssistantService } from './bot-assistant.service';
import { BotCrmService, CompanyDraft, PendingAction, humanStamp } from './bot-crm.service';
import { BotSpeechService, SpeechError } from './bot-speech.service';
import { InlineKeyboard, TelegramApiError, TelegramBotApi, TgCallbackQuery, TgMedia, TgMessage, TgUpdate } from './telegram-bot.api';
import { AuthUser } from '../auth/auth.guard';
import { SIGNED_OUT_EVENT, SignedOut } from '../auth/sign-out';

/**
 * Telegram bot of the CRM for the sales team (long polling, no public URL
 * needed). Each Telegram chat is linked to one CRM user through a one-time
 * link from the profile page; the bot then works as that user.
 *
 * Settings (env):
 *   CRM_BOT_TOKEN        token from @BotFather; without it the bot is off
 *   CRM_BOT_API_BASE     Bot API address (default https://api.telegram.org)
 *   CRM_PUBLIC_URL       address of the CRM web app, for links in messages
 *   CRM_BOT_MODEL (claude-opus-5-5), CRM_BOT_EFFORT (medium), CRM_BOT_MAX_PARALLEL, CRM_BOT_TIMEOUT_SEC, CRM_BOT_MAX_TURNS: assistant
 *   CRM_BOT_STT_URL, CRM_BOT_STT_TOKEN, CRM_BOT_STT_TIMEOUT_SEC, CRM_BOT_VOICE_MAX_SEC: voice messages (bot-speech.service.ts)
 */

const LINK_TTL_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** getFile of the Bot API serves files up to 20 MB */
const MAX_VOICE_BYTES = 20 * 1024 * 1024;
const BUSY = 'Ещё отвечаю на прошлое сообщение, секунду.';
const VOICE_OFF = 'Голосовые сообщения пока не распознаю: на сервере не настроено распознавание речи. Напишите, пожалуйста, текстом.';
const NOT_LINKED =
  'Этот Telegram не подключён к CRM.\n\nОткройте CRM → Профиль → «Telegram-бот» → «Подключить» и перейдите по ссылке оттуда.';
const HELP = (voice: string) => `Я помощник CRM Parisa Home. Что умею:

• Пишите обычным текстом: «что с Тест Текстиль?», «какие сделки у меня зависли?», «поставь задачу позвонить им завтра в 15:00».${voice}
• Пришлите фото или PDF карточки предприятия или визитки — я прочитаю её и предложу завести клиента.
• Напоминаю о задачах и присылаю утром список дел.

Команды:
/tasks — мои задачи на сегодня и просроченные
/deals — мои открытые сделки
/new — начать разговор заново
/unlink — отключить этот Telegram от CRM

Ничего не меняю в CRM без вашей кнопки «Подтвердить».`;

/** 180 -> "3 мин", 90 -> "90 с" */
function spoken(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} мин` : `${seconds} с`;
}

/** TypeORM returns [rows, count] for DELETE/UPDATE ... RETURNING on Postgres. */
function returned(result: any): any[] {
  return Array.isArray(result?.[0]) ? result[0] : result ?? [];
}

export function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

@Injectable()
export class BotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BotService.name);
  api: TelegramBotApi | null = null;
  username: string | null = null;
  private stopped = false;
  private offset = 0;
  /** chats whose voice message is being transcribed */
  private readonly listening = new Set<string>();

  constructor(
    private dataSource: DataSource,
    private crm: BotCrmService,
    private assistant: BotAssistantService,
    private recognition: RecognitionService,
    private speech: BotSpeechService,
  ) {}

  get enabled() {
    return !!this.api && !!this.username;
  }

  async onApplicationBootstrap() {
    const token = (process.env.CRM_BOT_TOKEN || '').trim();
    if (!token) {
      this.logger.log('CRM_BOT_TOKEN is not set: the Telegram bot is off');
      return;
    }
    this.api = new TelegramBotApi(token, process.env.CRM_BOT_API_BASE || undefined);
    void this.pollLoop();
  }

  onApplicationShutdown() {
    this.stopped = true;
  }

  private async pollLoop() {
    while (!this.stopped && !this.username) {
      try {
        const me = await this.api.getMe();
        this.username = me.username ?? null;
        this.logger.log(`Telegram bot @${this.username} started`);
      } catch (error) {
        this.logger.error(`Telegram bot cannot start: ${(error as Error).message}; retrying in 30 s`);
        await this.sleep(30_000);
      }
    }
    while (!this.stopped) {
      try {
        const updates = await this.api.getUpdates(this.offset, Number(process.env.CRM_BOT_POLL_SEC || 25));
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          // not awaited: a long Claude answer must not hold the other chats
          this.handleUpdate(update).catch((error) => this.logger.error(`update ${update.update_id}: ${error?.stack ?? error}`));
        }
      } catch (error) {
        this.logger.warn(`getUpdates: ${(error as Error).message}`);
        await this.sleep(5_000);
      }
    }
  }

  private get help() {
    return HELP(
      this.speech.enabled ? `\n• Или надиктуйте голосовым (до ${spoken(this.speech.maxSeconds)}): распознаю речь и отвечу так же, как на текст.` : '',
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ------------------------------------------------------------- linking

  async status(userId: number) {
    const rows = await this.dataSource.query('SELECT tg_username, linked_at FROM bot_account WHERE user_id = $1', [userId]);
    return {
      enabled: this.enabled,
      bot_username: this.username,
      linked: !!rows[0],
      tg_username: rows[0]?.tg_username ?? null,
      linked_at: rows[0]?.linked_at ?? null,
    };
  }

  async createLink(userId: number) {
    if (!this.enabled) throw new ServiceUnavailableException('Telegram-бот CRM не настроен на сервере');
    const code = randomBytes(18).toString('base64url');
    const expires = new Date(Date.now() + LINK_TTL_MS);
    await this.dataSource.query('DELETE FROM bot_link_code WHERE user_id = $1 OR expires_at < $2', [userId, new Date()]);
    await this.dataSource.query('INSERT INTO bot_link_code (code_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(code), userId, expires]);
    return { url: `https://t.me/${this.username}?start=${code}`, expires_at: expires, bot_username: this.username };
  }

  async unlink(userId: number) {
    const rows = returned(await this.dataSource.query('DELETE FROM bot_account WHERE user_id = $1 RETURNING chat_id', [userId]));
    const chatId = rows[0]?.chat_id;
    if (chatId) {
      this.assistant.forget(String(chatId));
      await this.send(chatId, 'Этот Telegram отключён от CRM.').catch(() => undefined);
    }
  }

  /** A new password or «выйти на всех устройствах» (auth/sign-out.ts) has already removed the link: say why. */
  @OnEvent(SIGNED_OUT_EVENT)
  async onSignedOut(signedOut: SignedOut) {
    for (const chatId of signedOut?.chatIds ?? []) {
      this.assistant.forget(chatId);
      await this.send(
        chatId,
        'Этот Telegram отключён от CRM: пароль сменён или выполнен выход на всех устройствах. Подключить снова: CRM → Профиль → «Telegram-бот».',
      ).catch(() => undefined);
    }
    if (signedOut?.chatIds?.length) this.logger.log(`CRM user ${signedOut.userId} signed out everywhere: the bot chat is unlinked`);
  }

  private async onStart(msg: TgMessage, code: string | undefined) {
    const chatId = String(msg.chat.id);
    if (!code) {
      const user = await this.userOfChat(chatId);
      return this.send(chatId, user ? `Вы вошли как ${user.username}.\n\n${this.help}` : NOT_LINKED);
    }
    const rows = returned(
      await this.dataSource.query('DELETE FROM bot_link_code WHERE code_hash = $1 RETURNING user_id, expires_at', [sha256(code)]),
    );
    const row = rows[0];
    if (!row?.user_id || new Date(row.expires_at) < new Date()) {
      return this.send(chatId, 'Ссылка недействительна или устарела. Получите новую в CRM: Профиль → «Telegram-бот».');
    }
    const user = await loadStaffUser(this.dataSource, row.user_id);
    if (!user) return this.send(chatId, 'Этот пользователь CRM удалён или заблокирован.');
    // the chat the user had linked before (another phone or Telegram account) is replaced
    const previous: string[] = [];
    await this.dataSource.transaction(async (m) => {
      const removed = returned(
        await m.query('DELETE FROM bot_account WHERE user_id = $1 OR chat_id = $2 RETURNING chat_id', [user.sub, chatId]),
      );
      for (const old of removed) if (String(old.chat_id) !== chatId) previous.push(String(old.chat_id));
      await m.query('INSERT INTO bot_account (user_id, chat_id, tg_username) VALUES ($1, $2, $3)', [
        user.sub,
        chatId,
        msg.from?.username ?? null,
      ]);
    });
    this.assistant.forget(chatId);
    // ... and is told so: a link made by somebody else with the user's CRM login does not go unnoticed
    for (const old of previous) {
      this.assistant.forget(old);
      await this.send(
        old,
        `Этот Telegram отключён от CRM: ${user.username} подключил бота CRM в другом чате. Если это были не вы — смените пароль в CRM.`,
      ).catch(() => undefined);
    }
    this.logger.log(`CRM user ${user.sub} linked a Telegram chat${previous.length ? ' (the previous chat is unlinked)' : ''}`);
    return this.send(chatId, `Готово, вы вошли как ${user.username}.\n\n${this.help}`);
  }

  private async userOfChat(chatId: string): Promise<AuthUser | null> {
    const rows = await this.dataSource.query('SELECT user_id FROM bot_account WHERE chat_id = $1', [chatId]);
    return rows[0] ? loadStaffUser(this.dataSource, rows[0].user_id) : null;
  }

  // ------------------------------------------------------------- updates

  async handleUpdate(update: TgUpdate) {
    if (update.message) return this.onMessage(update.message);
    if (update.callback_query) return this.onCallback(update.callback_query);
  }

  private async onMessage(msg: TgMessage) {
    if (msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;
    const chatId = String(msg.chat.id);
    const text = (msg.text ?? '').trim();

    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text);
    if (start) return this.onStart(msg, start[1]);

    const user = await this.userOfChat(chatId);
    if (!user) return this.send(chatId, NOT_LINKED);

    const command = /^\/(\w+)(?:@\w+)?/.exec(text)?.[1]?.toLowerCase();
    if (command === 'help') return this.send(chatId, this.help);
    if (command === 'tasks') return this.sendTasks(user, chatId);
    if (command === 'deals') return this.sendDeals(user, chatId);
    if (command === 'new') {
      this.assistant.forget(chatId);
      return this.send(chatId, 'Начали заново.');
    }
    if (command === 'unlink') return this.unlink(user.sub);
    if (command) return this.send(chatId, 'Не знаю такой команды. /help — что я умею.');

    const media = msg.voice ?? msg.audio ?? msg.video_note;
    if (media) return this.onVoice(user, chatId, media);
    if (msg.photo?.length || msg.document) return this.onCard(user, chatId, msg);
    if (!text) return this.send(chatId, 'Пока понимаю только текст, голосовые, фото и PDF.');
    if (text.length > 3000) return this.send(chatId, 'Слишком длинное сообщение, сократите, пожалуйста.');
    return this.onText(user, chatId, text);
  }

  /** A typed message, or the text of a voice message: one question to the assistant. */
  private async onText(user: AuthUser, chatId: string, text: string) {
    if (this.isBusy(chatId)) return this.send(chatId, BUSY);
    const typing = this.keepTyping(chatId);
    try {
      const reply = await this.assistant.ask(user, chatId, text);
      await this.send(chatId, reply.text || 'Готово.');
      for (const action of reply.actions) await this.sendAction(action);
    } finally {
      clearInterval(typing);
    }
  }

  private isBusy(chatId: string) {
    return this.assistant.isBusy(chatId) || this.listening.has(chatId);
  }

  // ------------------------------------------------------------- voice

  /**
   * Voice message, audio file or round video: transcribed by parisahon-stt, shown to the
   * manager as "🎤 …" and then handled exactly like the same text typed (assistant, buttons, rights).
   */
  private async onVoice(user: AuthUser, chatId: string, media: TgMedia) {
    if (!this.speech.enabled) return this.send(chatId, VOICE_OFF);
    const maxSec = this.speech.maxSeconds;
    if ((media.duration ?? 0) > maxSec || (media.file_size ?? 0) > MAX_VOICE_BYTES) return this.send(chatId, this.tooLong(maxSec));
    if (this.isBusy(chatId)) return this.send(chatId, BUSY);

    this.listening.add(chatId);
    const typing = this.keepTyping(chatId);
    let text: string;
    try {
      const audio = await this.api.downloadFile(media.file_id, MAX_VOICE_BYTES);
      text = (await this.speech.transcribe(audio)).text;
    } catch (error) {
      return this.send(chatId, this.voiceErrorText(error, maxSec));
    } finally {
      clearInterval(typing);
      this.listening.delete(chatId);
    }
    if (!text) return this.send(chatId, 'Не разобрал слов в голосовом. Повторите, пожалуйста, или напишите текстом.');
    await this.send(chatId, `🎤 ${text}`);
    return this.onText(user, chatId, text);
  }

  private tooLong(maxSec: number) {
    return `Голосовое длиннее ${spoken(maxSec)} — такие длинные не распознаю. Запишите покороче или напишите текстом.`;
  }

  private voiceErrorText(error: unknown, maxSec: number) {
    if (error instanceof SpeechError) {
      if (error.kind === 'too_long') return this.tooLong(maxSec);
      if (error.kind === 'bad_audio') return 'Не смог прочитать звук из этого сообщения. Запишите голосовое ещё раз или напишите текстом.';
      if (error.kind === 'off') return VOICE_OFF;
      return 'Распознавание речи сейчас недоступно, голосовое не прочитано. Напишите, пожалуйста, текстом — остальное работает.';
    }
    if (error instanceof TelegramApiError) {
      if (/too large/.test(error.message)) return this.tooLong(maxSec);
      this.logger.warn(`voice download: ${error.message}`);
      return 'Не получилось скачать голосовое из Telegram. Отправьте его ещё раз, пожалуйста.';
    }
    this.logger.error(`voice: ${(error as Error)?.stack ?? error}`);
    return 'Не получилось распознать голосовое. Напишите, пожалуйста, текстом.';
  }

  private keepTyping(chatId: string) {
    const tick = () => this.api?.sendChatAction(chatId).catch(() => undefined);
    tick();
    return setInterval(tick, 4500);
  }

  // ------------------------------------------------------------- card photo

  private async onCard(user: AuthUser, chatId: string, msg: TgMessage) {
    let fileId: string;
    let mimetype: string;
    let name = 'card';
    if (msg.photo?.length) {
      const best = msg.photo[msg.photo.length - 1];
      fileId = best.file_id;
      mimetype = 'image/jpeg';
    } else {
      fileId = msg.document.file_id;
      mimetype = msg.document.mime_type ?? '';
      name = msg.document.file_name ?? name;
      if (!RecognitionService.acceptedMimeTypes.includes(mimetype)) {
        return this.send(chatId, 'Пришлите фото, картинку (JPEG, PNG, WebP) или PDF карточки.');
      }
      if ((msg.document.file_size ?? 0) > MAX_FILE_BYTES) return this.send(chatId, 'Файл больше 10 МБ.');
    }
    const access = new BotAccess(user);
    if (!access.canCreateCompany()) return this.send(chatId, 'У вас нет права создавать компании в CRM.');

    const typing = this.keepTyping(chatId);
    try {
      const buffer = await this.api.downloadFile(fileId, MAX_FILE_BYTES);
      const result = await this.recognition.recognizeCard({
        buffer,
        mimetype,
        size: buffer.length,
        originalname: name,
      } as Express.Multer.File);

      if (result.document_type === 'other' || !result.company.name) {
        return this.send(
          chatId,
          result.document_type === 'other'
            ? 'Это не похоже на карточку предприятия или визитку.'
            : 'Не смог прочитать название компании. Пришлите фото почётче или напишите данные текстом.',
        );
      }

      const prepared: any = await this.crm.prepareCompany(access, chatId, { ...result.company, contacts: result.contacts } as CompanyDraft);
      const warnings = result.warnings.map((w) => `⚠️ ${w.message}`);
      if (prepared.status === 'duplicate') {
        const lines = ['Такая компания уже есть в CRM:'];
        for (const c of prepared.existing) lines.push(`• ${c.name}${c.inn ? `, ИНН ${c.inn}` : ''}${c.crm_url ? `\n  ${c.crm_url}` : ''}`);
        return this.send(chatId, lines.join('\n'));
      }
      const similar = result.duplicates.companies.filter((c) => c.match === 'name');
      if (similar.length) warnings.push(`Похожие компании в CRM: ${similar.map((c) => c.name).join(', ')}`);
      for (const c of result.duplicates.contacts) warnings.push(`Контакт ${c.username} уже есть в CRM`);
      const action = this.crm.getPending(prepared.action_id);
      if (action && warnings.length) action.summary += `\n\n${warnings.join('\n')}`;
      if (result.notes) action && (action.summary += `\n\nПримечание: ${result.notes}`);
      if (action) await this.sendAction(action, 'Прочитал карточку. Проверьте и подтвердите:');
    } catch (error) {
      return this.send(chatId, `Не получилось прочитать карточку: ${this.errorText(error)}`);
    } finally {
      clearInterval(typing);
    }
  }

  // ------------------------------------------------------------- buttons

  async sendAction(action: PendingAction, intro?: string) {
    const keyboard: InlineKeyboard = [
      [
        { text: '✅ Подтвердить', callback_data: `ok:${action.id}` },
        { text: '✖️ Отмена', callback_data: `no:${action.id}` },
      ],
    ];
    await this.send(action.chatId, `${intro ? `${intro}\n\n` : ''}${action.summary}`, keyboard);
  }

  private async onCallback(query: TgCallbackQuery) {
    const chatId = String(query.message?.chat.id ?? query.from.id);
    const messageId = query.message?.message_id;
    const data = query.data ?? '';
    const user = await this.userOfChat(chatId);
    if (!user || query.from.id !== Number(chatId)) {
      return this.api.answerCallbackQuery(query.id, 'Этот Telegram не подключён к CRM');
    }

    const [kind, ref] = data.split(':');
    if (kind === 'done') {
      // "✅ Выполнено" under a reminder or the task list: the press is the confirmation
      try {
        const prepared: any = await this.crm.prepareCloseTask(new BotAccess(user), chatId, {
          task_id: Number(ref),
          result: 'Выполнено (отмечено в Telegram)',
        });
        const action = this.crm.getPending(prepared.action_id);
        const text = await this.crm.execute(action, user);
        this.crm.dropPending(action.id);
        await this.api.answerCallbackQuery(query.id, 'Задача закрыта');
        if (messageId) await this.send(chatId, text);
      } catch (error) {
        await this.api.answerCallbackQuery(query.id, this.errorText(error).slice(0, 190));
      }
      return;
    }

    const action = this.crm.getPending(ref ?? '');
    if (!action || action.userId !== user.sub || action.chatId !== chatId) {
      await this.api.answerCallbackQuery(query.id, 'Это действие устарело');
      if (messageId) await this.api.editMessageText(chatId, messageId, `${query.message?.text ?? ''}\n\n(устарело)`).catch(() => undefined);
      return;
    }
    if (action.state !== 'pending') return this.api.answerCallbackQuery(query.id, 'Уже выполняется');

    if (kind === 'no') {
      this.crm.dropPending(action.id);
      await this.api.answerCallbackQuery(query.id, 'Отменено');
      if (messageId) await this.api.editMessageText(chatId, messageId, `${action.summary}\n\n✖️ Отменено`).catch(() => undefined);
      return;
    }
    if (kind !== 'ok') return this.api.answerCallbackQuery(query.id);

    action.state = 'running';
    await this.api.answerCallbackQuery(query.id, 'Сохраняю…');
    try {
      const text = await this.crm.execute(action, user);
      action.state = 'done';
      this.crm.dropPending(action.id);
      if (messageId) await this.api.editMessageText(chatId, messageId, `${action.summary}\n\n${text}`).catch(() => this.send(chatId, text));
      else await this.send(chatId, text);
    } catch (error) {
      action.state = 'pending';
      await this.send(chatId, `Не сохранилось: ${this.errorText(error)}`);
    }
  }

  // ------------------------------------------------------------- lists

  /** Today's and overdue tasks with "done" buttons. As the morning digest nothing is sent when there are none. */
  async sendTasks(user: AuthUser, chatId: string, digest = false) {
    const access = new BotAccess(user);
    const today = await this.crm.listTasks(access, { period: 'today' });
    const overdue = await this.crm.listTasks(access, { period: 'overdue' });
    const seen = new Set<number>();
    const lines: string[] = [];
    const buttons: InlineKeyboard = [];
    const add = (title: string, tasks: any[]) => {
      const fresh = tasks.filter((t) => !seen.has(t.id));
      if (!fresh.length) return;
      lines.push(title);
      for (const t of fresh) {
        seen.add(t.id);
        lines.push(this.taskLine(t));
        if (buttons.length < 8) buttons.push([{ text: `✅ ${t.title.slice(0, 40)}`, callback_data: `done:${t.id}` }]);
      }
      lines.push('');
    };
    add('Просрочено:', overdue.tasks);
    add('На сегодня:', today.tasks);
    if (!lines.length) return digest ? undefined : this.send(chatId, 'На сегодня задач нет, просроченных тоже.');
    const intro = digest ? `Доброе утро, ${user.username}! Ваши задачи:\n\n` : '';
    return this.send(chatId, intro + lines.join('\n').trim(), buttons);
  }

  taskLine(t: any) {
    const when = t.all_day ? 'весь день' : t.start?.split(' ')[1];
    const day = t.start ? humanStamp(t.start, false) : '';
    const about = [t.company, t.deal_number ? `сделка №${t.deal_number}` : null].filter(Boolean).join(', ');
    return `• ${t.overdue ? `${day} ` : ''}${when ?? ''} — ${t.title}${about ? ` (${about})` : ''}`;
  }

  private async sendDeals(user: AuthUser, chatId: string) {
    const result: any = await this.crm.listDeals(new BotAccess(user), { mine: true, status: 'open', limit: 20 });
    if (result.error) return this.send(chatId, result.error);
    if (!result.deals.length) return this.send(chatId, 'Открытых сделок, где вы ответственный, нет.');
    const lines = ['Ваши открытые сделки:'];
    for (const d of result.deals) {
      const budget = d.budget ? `, ${d.budget.toLocaleString('ru-RU')}` : '';
      lines.push(`• №${d.number} ${d.title} — ${d.company ?? 'без компании'}, ${d.stage ?? '—'}${budget}`);
    }
    return this.send(chatId, lines.join('\n'));
  }

  // ------------------------------------------------------------- helpers

  async send(chatId: string | number, text: string, keyboard?: InlineKeyboard) {
    if (!this.api) return;
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > 4000) {
      const cutAt = Math.max(rest.lastIndexOf('\n', 4000), 2000);
      chunks.push(rest.slice(0, cutAt));
      rest = rest.slice(cutAt).trimStart();
    }
    chunks.push(rest);
    for (let i = 0; i < chunks.length; i += 1) {
      await this.api.sendMessage(chatId, chunks[i], i === chunks.length - 1 ? keyboard : undefined);
    }
  }

  private errorText(error: unknown): string {
    if (error instanceof HttpException) {
      const response: any = error.getResponse();
      const message = typeof response === 'string' ? response : response?.message ?? error.message;
      return Array.isArray(message) ? message.join('; ') : String(message);
    }
    this.logger.error((error as Error)?.stack ?? String(error));
    return 'внутренняя ошибка';
  }
}
