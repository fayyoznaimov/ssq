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
import { BotCrmService, CompanyDraft, ExecuteResult, PendingAction, PlanWarning, TaskDraft, TaskView } from './bot-crm.service';
import { ViableAssignTargets } from '../task/dto/create.task.dto';
import { BotSpeechService, SpeechError } from './bot-speech.service';
import { InlineKeyboard, TelegramApiError, TelegramBotApi, TgCallbackQuery, TgMedia, TgMessage, TgUpdate } from './telegram-bot.api';
import { clip, dayText, hhmm, minutesText, parseWhen, plural, spanText, taskButtonText } from './bot-format';
import { AuthUser } from '../auth/auth.guard';
import { SIGNED_OUT_EVENT, SignedOut } from '../auth/sign-out';
import { AuditContext } from '../audit/audit-context';
import { AuditJournal } from '../audit/audit-journal';

/**
 * Telegram bot of the CRM for the sales team (long polling, no public URL
 * needed). Each Telegram chat is linked to one CRM user through a one-time
 * link from the profile page; the bot then works as that user.
 *
 * Tasks are worked with buttons (a reminder, /tasks, the morning digest): a task card has «✅ Выполнено»
 * (asks for the outcome), «⏩ Перенести» (+1 час, завтра 10:00, своя дата), «✏️ Изменить» (текст, время)
 * and «🗑 Удалить» (with a confirmation) — within the user's rights, as the web.
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
/** how long the bot waits for the outcome, the new text or the new time of a task the manager is asked for */
const AWAIT_MS = 10 * 60 * 1000;
/** task buttons on one page of /tasks and the digest */
const PAGE = 8;
const DONE_DEFAULT = 'Выполнено (отмечено в Telegram)';
const WHEN_HELP = 'Например: «завтра 15:00», «25.11 10:30», «пт 9:00», «через 2 часа», «15:30» (сегодня) или «25.11» (весь день).';
const BUSY = 'Ещё отвечаю на прошлое сообщение, секунду.';
const VOICE_OFF = 'Голосовые сообщения пока не распознаю: на сервере не настроено распознавание речи. Напишите, пожалуйста, текстом.';
const NOT_LINKED =
  'Этот Telegram не подключён к CRM.\n\nОткройте CRM → Профиль → «Telegram-бот» → «Подключить» и перейдите по ссылке оттуда.';
const HELP = (voice: string) => `Я помощник CRM Parisa Home. Что умею:

• Пишите обычным текстом: «что с Тест Текстиль?», «какие сделки у меня зависли?», «поставь задачу позвонить им завтра в 15:00», «поручи Комилджону позвонить им в пятницу», «перенеси звонок на 16:00», «напомни мне подготовить отчёт в 18:00».${voice}
• Пришлите фото или PDF карточки предприятия или визитки — я прочитаю её и предложу завести клиента.
• Напоминаю о задачах и присылаю утром список дел. Под каждой задачей кнопки: выполнено, перенести, изменить, удалить.

Команды:
/tasks — мои задачи на сегодня и просроченные
/deals — мои открытые сделки
/new — начать разговор заново
/unlink — отключить этот Telegram от CRM

Ничего не меняю в CRM без вашей кнопки.`;

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

/** What the bot waits for in a chat after a button: the outcome of a task, its new time or its new text. */
interface Awaiting {
  kind: 'result' | 'when' | 'text';
  taskId: number;
  userId: number;
  /** the message that asked (its buttons go when the answer comes) */
  messageId: number | null;
  until: number;
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
  private readonly awaiting = new Map<string, Awaiting>();

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
          // the journal (src/audit): what the update changes is the bot's, acting for the linked user
          const chat = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? update.callback_query?.from?.id;
          AuditContext.run({ source: 'bot', sourceRef: chat ? `chat:${chat}` : null }, () => this.handleUpdate(update)).catch((error) =>
            this.logger.error(`update ${update.update_id}: ${error?.stack ?? error}`),
          );
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
    const rows = returned(
      await AuditJournal.around(this.dataSource, 'bot_account', 't.user_id = $1', [userId], () =>
        this.dataSource.query('DELETE FROM bot_account WHERE user_id = $1 RETURNING chat_id', [userId]),
      ),
    );
    const chatId = rows[0]?.chat_id;
    if (chatId) {
      this.forgetChat(String(chatId));
      await this.send(chatId, 'Этот Telegram отключён от CRM.').catch(() => undefined);
    }
  }

  /** A new password or «выйти на всех устройствах» (auth/sign-out.ts) has already removed the link: say why. */
  @OnEvent(SIGNED_OUT_EVENT)
  async onSignedOut(signedOut: SignedOut) {
    for (const chatId of signedOut?.chatIds ?? []) {
      this.forgetChat(chatId);
      await this.send(
        chatId,
        'Этот Telegram отключён от CRM: пароль сменён или выполнен выход на всех устройствах. Подключить снова: CRM → Профиль → «Telegram-бот».',
      ).catch(() => undefined);
    }
    if (signedOut?.chatIds?.length) this.logger.log(`CRM user ${signedOut.userId} signed out everywhere: the bot chat is unlinked`);
  }

  private forgetChat(chatId: string) {
    this.assistant.forget(chatId);
    this.awaiting.delete(chatId);
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
    const newName = msg.from?.username ?? null;
    AuditContext.setActor(user.sub, user.username ?? null);
    await this.dataSource.transaction(async (m) => {
      const removed = returned(
        await AuditJournal.around(m, 'bot_account', 't.user_id = $1 OR t.chat_id = $2', [user.sub, chatId], () =>
          m.query('DELETE FROM bot_account WHERE user_id = $1 OR chat_id = $2 RETURNING user_id, chat_id, digest_on', [user.sub, chatId]),
        ),
      );
      for (const old of removed) if (String(old.chat_id) !== chatId) previous.push(String(old.chat_id));
      // the morning digest already sent today is not sent again because the chat changed
      const digestOn = removed.find((old) => Number(old.user_id) === user.sub)?.digest_on ?? null;
      await m.query('INSERT INTO bot_account (user_id, chat_id, tg_username, digest_on) VALUES ($1, $2, $3, $4)', [
        user.sub,
        chatId,
        newName,
        digestOn,
      ]);
      await AuditJournal.inserted(m, 'bot_account', [user.sub]);
    });
    this.forgetChat(chatId);
    // ... and is told so: a link made by somebody else with the user's CRM login does not go unnoticed
    for (const old of previous) {
      this.forgetChat(old);
      await this.send(
        old,
        `Этот Telegram отключён от CRM: ${user.username} подключил бота CRM в другом чате${newName ? ` (Telegram @${newName})` : ''}. ` +
          'Если это были не вы — смените пароль в CRM и сообщите администратору.',
      ).catch(() => undefined);
    }
    this.logger.log(`CRM user ${user.sub} linked a Telegram chat${previous.length ? ' (the previous chat is unlinked)' : ''}`);
    return this.send(chatId, `Готово, вы вошли как ${user.username}.\n\n${this.help}`);
  }

  private async userOfChat(chatId: string): Promise<AuthUser | null> {
    const rows = await this.dataSource.query('SELECT user_id FROM bot_account WHERE chat_id = $1', [chatId]);
    const user = rows[0] ? await loadStaffUser(this.dataSource, rows[0].user_id) : null;
    // the journal: everything this update changes is done by this user through the bot
    if (user) AuditContext.setActor(user.sub, user.username ?? null);
    return user;
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
    if (command) this.awaiting.delete(chatId);
    if (command === 'help') return this.send(chatId, this.help);
    if (command === 'tasks') return this.sendTasks(user, chatId);
    if (command === 'deals') return this.sendDeals(user, chatId);
    if (command === 'new') {
      this.forgetChat(chatId);
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

  /** A typed message, or the text of a voice message: the answer the bot asked for, or one question to the assistant. */
  private async onText(user: AuthUser, chatId: string, text: string) {
    const waiting = this.awaiting.get(chatId);
    if (waiting && waiting.until > Date.now() && waiting.userId === user.sub) return this.onAnswer(user, chatId, waiting, text);
    this.awaiting.delete(chatId);
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

  // ------------------------------------------------------------- confirmations

  private actionKeyboard(action: PendingAction): InlineKeyboard {
    const keyboard: InlineKeyboard = [
      [
        { text: action.kind === 'delete_task' ? '🗑 Да, удалить' : '✅ Подтвердить', callback_data: `ok:${action.id}` },
        { text: '✖️ Отмена', callback_data: `no:${action.id}` },
      ],
    ];
    // a task on a colleague's deal: one press gives it to the deal's responsible instead
    const draft = action.kind === 'create_task' ? (action.payload as TaskDraft) : null;
    if (draft?.responsible && !(draft.dto.assign_to.target === ViableAssignTargets.AGENT && draft.dto.assign_to.id === draft.responsible.id)) {
      keyboard.push([{ text: `👤 Поручить ответственному: ${clip(draft.responsible.name, 30)}`, callback_data: `rs:${action.id}` }]);
    }
    return keyboard;
  }

  async sendAction(action: PendingAction, intro?: string) {
    await this.send(action.chatId, `${intro ? `${intro}\n\n` : ''}${action.summary}`, this.actionKeyboard(action));
  }

  private async onCallback(query: TgCallbackQuery) {
    const chatId = String(query.message?.chat.id ?? query.from.id);
    const messageId = query.message?.message_id ?? null;
    const data = query.data ?? '';
    const user = await this.userOfChat(chatId);
    if (!user || query.from.id !== Number(chatId)) {
      return this.api.answerCallbackQuery(query.id, 'Этот Telegram не подключён к CRM');
    }

    const [kind, ref, extra, extra2] = data.split(':');
    // another button ends the wait for a typed answer (an outcome must not land on the wrong task)
    if (kind !== 'tp') this.awaiting.delete(chatId);
    if (!['ok', 'no', 'rs'].includes(kind)) {
      try {
        await this.onTaskButton(user, chatId, messageId, query, kind, ref, extra, extra2);
      } catch (error) {
        await this.api.answerCallbackQuery(query.id, this.errorText(error).slice(0, 190)).catch(() => undefined);
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
    if (kind === 'rs') {
      try {
        await this.crm.assignDraftToResponsible(action, user);
        await this.api.answerCallbackQuery(query.id, 'Исполнитель изменён');
        if (messageId) await this.api.editMessageText(chatId, messageId, action.summary, this.actionKeyboard(action)).catch(() => this.sendAction(action));
      } catch (error) {
        await this.api.answerCallbackQuery(query.id, this.errorText(error).slice(0, 190));
      }
      return;
    }

    action.state = 'running';
    await this.api.answerCallbackQuery(query.id, 'Сохраняю…');
    try {
      const result = await this.crm.execute(action, user);
      action.state = 'done';
      this.crm.dropPending(action.id);
      if (messageId) await this.api.editMessageText(chatId, messageId, `${action.summary}\n\n${result.text}`).catch(() => this.send(chatId, result.text));
      else await this.send(chatId, result.text);
      await this.afterExecute(result, user);
    } catch (error) {
      action.state = 'pending';
      if (error instanceof PlanWarning) {
        // the summary now has the warning; the same buttons confirm it
        if (messageId) await this.api.editMessageText(chatId, messageId, action.summary, this.actionKeyboard(action)).catch(() => this.sendAction(action));
        else await this.sendAction(action);
        return;
      }
      await this.send(chatId, `Не сохранилось: ${this.errorText(error)}`);
    }
  }

  /** A task given to somebody else: they get it in their bot at once, with its buttons. */
  private async afterExecute(result: ExecuteResult, by: AuthUser) {
    if (!result.assignedTaskId) return;
    const recipients = await this.crm.taskRecipients(result.assignedTaskId, by.sub).catch(() => []);
    for (const r of recipients) {
      const forGroup = !r.task.agent_id;
      await this.send(
        r.chatId,
        `📌 ${by.username} ${forGroup ? 'поставил(а) задачу вашей группе' : 'поручил(а) вам задачу'}:\n${this.crm.taskText(r.task, r.user.sub)}`,
        this.taskKeyboard(r.task),
      ).catch((error) => this.logger.warn(`task ${result.assignedTaskId} to user ${r.user.sub}: ${(error as Error).message}`));
    }
  }

  // ------------------------------------------------------------- task buttons

  /** The buttons of a task card: the main ones, «Перенести» or «Изменить». Only what the user may do. */
  taskKeyboard(task: TaskView, menu: 'main' | 'move' | 'edit' = 'main'): InlineKeyboard {
    if (!task.can_update) return [];
    const id = task.id;
    if (menu === 'move') {
      return [
        [
          { text: '+1 час', callback_data: `mh:${id}` },
          { text: 'Завтра 10:00', callback_data: `mt:${id}` },
        ],
        [{ text: '📅 Своя дата и время', callback_data: `mc:${id}` }],
        [{ text: '‹ Назад', callback_data: `bk:${id}` }],
      ];
    }
    if (menu === 'edit') {
      return [
        [
          { text: '✏️ Текст', callback_data: `et:${id}` },
          { text: '🕒 Дата и время', callback_data: `mc:${id}` },
        ],
        [{ text: '‹ Назад', callback_data: `bk:${id}` }],
      ];
    }
    const second: InlineKeyboard[number] = [{ text: '✏️ Изменить', callback_data: `ed:${id}` }];
    if (task.can_delete) second.push({ text: '🗑 Удалить', callback_data: `dl:${id}` });
    return [
      [
        { text: '✅ Выполнено', callback_data: `dn:${id}` },
        { text: '⏩ Перенести', callback_data: `mv:${id}` },
      ],
      second,
    ];
  }

  private async onTaskButton(
    user: AuthUser,
    chatId: string,
    messageId: number | null,
    query: TgCallbackQuery,
    kind: string,
    ref: string,
    extra?: string,
    extra2?: string,
  ) {
    const access = new BotAccess(user);
    const answer = (text?: string) => this.api.answerCallbackQuery(query.id, text).catch(() => undefined);
    const taskId = Number(ref);
    const setKeyboard = async (keyboard: InlineKeyboard) => {
      if (messageId) await this.api.editMessageReplyMarkup(chatId, messageId, keyboard).catch(() => undefined);
    };

    switch (kind) {
      case 'tp': {
        // another page of /tasks or of the digest: only the buttons change
        await answer();
        const page = await this.tasksPage(user, Math.max(Number(ref) || 0, 0));
        return setKeyboard(page.keyboard);
      }
      case 'ax': {
        this.awaiting.delete(chatId);
        await answer('Хорошо');
        if (messageId) await this.api.editMessageText(chatId, messageId, `${query.message?.text || 'Задача'}\n\n✖️ Не меняю`).catch(() => undefined);
        return;
      }
      case 'tk': {
        const task = await this.crm.taskView(access, taskId);
        await answer();
        if (task.closed) return this.send(chatId, `Задача «${task.title}» уже закрыта.`);
        return this.send(chatId, this.crm.taskText(task, user.sub), this.taskKeyboard(task));
      }
    }

    // everything else changes the task: the user's right to change it, as PATCH /tasks/:id
    const task = await this.crm.taskView(access, taskId);
    if (task.closed) {
      await answer('Задача уже закрыта');
      return setKeyboard([]);
    }
    const mayChange = kind === 'dl' ? task.can_delete : task.can_update;
    if (!mayChange) return answer(`Нет прав ${kind === 'dl' ? 'удалить' : 'менять'} эту задачу`);

    switch (kind) {
      case 'mv':
      case 'ed':
      case 'bk':
        await answer();
        return setKeyboard(this.taskKeyboard(task, kind === 'mv' ? 'move' : kind === 'ed' ? 'edit' : 'main'));
      case 'done':
      case 'dn': {
        // not closed by one press (a slip of the finger closed the wrong task for good): the outcome, then it closes
        await answer();
        const about = this.crm.aboutText(task);
        const asked = await this.send(
          chatId,
          `Закрываю задачу «${task.title}»${about ? ` (${about})` : ''}.\n\nНапишите итог одним сообщением: что сделано, о чём договорились. ` +
            'Или закройте без итога.',
          [
            [{ text: '✅ Закрыть без итога', callback_data: `dc:${task.id}` }],
            [{ text: '✖️ Не закрывать', callback_data: `ax:${task.id}` }],
          ],
        );
        this.awaiting.set(chatId, { kind: 'result', taskId: task.id, userId: user.sub, messageId: asked?.message_id ?? null, until: Date.now() + AWAIT_MS });
        return;
      }
      case 'dc': {
        this.awaiting.delete(chatId);
        const result = await this.closeTask(user, chatId, task.id, DONE_DEFAULT);
        await answer('Задача закрыта');
        if (messageId) await this.api.editMessageText(chatId, messageId, result.text).catch(() => this.send(chatId, result.text));
        else await this.send(chatId, result.text);
        return;
      }
      case 'mh':
      case 'mt':
      case 'mf': {
        const to = kind === 'mf' ? (extra === 't' ? 'tomorrow' : 'hour') : kind === 'mt' ? 'tomorrow' : 'hour';
        const moved = await this.crm.moveTask(user, task.id, to, kind === 'mf');
        if (moved.status === 'duplicate') {
          await answer();
          return this.send(chatId, `⚠️ ${moved.message}\n\nВсё равно перенести «${task.title}»?`, [
            [
              { text: 'Да, перенести', callback_data: `mf:${task.id}:${to === 'tomorrow' ? 't' : 'h'}` },
              { text: 'Нет', callback_data: `ax:${task.id}` },
            ],
          ]);
        }
        await answer('Перенесено');
        if (kind === 'mf' && messageId) await setKeyboard([]);
        else await setKeyboard(this.taskKeyboard(moved.task));
        return this.sendMoved(chatId, moved.before, moved.task);
      }
      case 'ub': {
        // «Вернуть как было»: the start before the quick move (minutes since 1970), all day or not
        const start = new Date(Number(extra) * 60_000);
        if (!Number(extra) || Number.isNaN(start.getTime())) return answer('Это действие устарело');
        const moved = await this.crm.moveTask(user, task.id, { start, allDay: extra2 === '1' }, true);
        await answer('Вернул');
        const text = moved.status === 'moved' ? `↩️ Вернул как было: «${moved.task.title}», ${spanText(moved.task.start, moved.task.end, moved.task.all_day)}` : 'Готово';
        if (messageId) await this.api.editMessageText(chatId, messageId, text, moved.status === 'moved' ? this.taskKeyboard(moved.task) : []).catch(() => this.send(chatId, text));
        return;
      }
      case 'mc': {
        await answer();
        const asked = await this.send(
          chatId,
          `Новые дата и время задачи «${task.title}» (сейчас ${spanText(task.start, task.end, task.all_day)})?\n${WHEN_HELP}`,
          [[{ text: '✖️ Не переносить', callback_data: `ax:${task.id}` }]],
        );
        this.awaiting.set(chatId, { kind: 'when', taskId: task.id, userId: user.sub, messageId: asked?.message_id ?? null, until: Date.now() + AWAIT_MS });
        return;
      }
      case 'et': {
        await answer();
        const asked = await this.send(chatId, `Сейчас: «${task.title}».\nНапишите новый текст задачи одним сообщением.`, [
          [{ text: '✖️ Не менять', callback_data: `ax:${task.id}` }],
        ]);
        this.awaiting.set(chatId, { kind: 'text', taskId: task.id, userId: user.sub, messageId: asked?.message_id ?? null, until: Date.now() + AWAIT_MS });
        return;
      }
      case 'dl': {
        const prepared: any = await this.crm.prepareDeleteTask(access, chatId, { task_id: task.id });
        await answer();
        const action = this.crm.getPending(prepared.action_id);
        if (action) await this.sendAction(action);
        return;
      }
      default:
        return answer();
    }
  }

  /** The answer to «Напишите итог / новое время / новый текст». */
  private async onAnswer(user: AuthUser, chatId: string, waiting: Awaiting, text: string) {
    const access = new BotAccess(user);
    const dropButtons = async () => {
      if (waiting.messageId) await this.api.editMessageReplyMarkup(chatId, waiting.messageId, []).catch(() => undefined);
    };
    try {
      if (waiting.kind === 'result') {
        this.awaiting.delete(chatId);
        await dropButtons();
        const result = await this.closeTask(user, chatId, waiting.taskId, text.slice(0, 2000));
        return this.send(chatId, result.text);
      }
      if (waiting.kind === 'text') {
        const prepared: any = await this.crm.prepareTaskChange(access, chatId, waiting.taskId, { label: text });
        this.awaiting.delete(chatId);
        await dropButtons();
        const action = this.crm.getPending(prepared.action_id);
        return action ? this.sendAction(action) : undefined;
      }
      // a new date and time
      const task = await this.crm.taskView(access, waiting.taskId);
      const parsed = parseWhen(text);
      if (!parsed) return this.send(chatId, `Не понял дату. ${WHEN_HELP}\nИли нажмите «Не переносить».`);
      let start = parsed.start;
      let allDay = false;
      if (parsed.dateOnly) {
        // a day without a time: the task keeps its time of day (an all-day task stays all-day)
        allDay = task.all_day;
        if (!task.all_day) start = new Date(start.getFullYear(), start.getMonth(), start.getDate(), task.start.getHours(), task.start.getMinutes());
      } else if (parsed.timeOnly && task.start.getTime() > Date.now() && !sameDay(task.start, new Date())) {
        // only a time for a task of a later day: that day
        start = new Date(task.start.getFullYear(), task.start.getMonth(), task.start.getDate(), start.getHours(), start.getMinutes());
      }
      const prepared: any = await this.crm.prepareTaskChange(access, chatId, waiting.taskId, { start, allDay });
      this.awaiting.delete(chatId);
      await dropButtons();
      const action = this.crm.getPending(prepared.action_id);
      return action ? this.sendAction(action) : undefined;
    } catch (error) {
      if (waiting.kind === 'result') return this.send(chatId, `Не получилось закрыть задачу: ${this.errorText(error)}`);
      return this.send(chatId, `${this.errorText(error)}. Напишите ещё раз или нажмите «Не менять».`);
    }
  }

  private async closeTask(user: AuthUser, chatId: string, taskId: number, result: string): Promise<ExecuteResult> {
    const prepared: any = await this.crm.prepareCloseTask(new BotAccess(user), chatId, { task_id: taskId, result });
    const action = this.crm.getPending(prepared.action_id);
    try {
      return await this.crm.execute(action, user);
    } finally {
      this.crm.dropPending(action.id);
    }
  }

  /** «Перенесено» with the old and the new time and «Вернуть как было». */
  private async sendMoved(chatId: string, before: TaskView, after: TaskView) {
    const back = `ub:${after.id}:${Math.floor(before.start.getTime() / 60_000)}:${before.all_day ? 1 : 0}`;
    await this.send(
      chatId,
      `⏩ Задача перенесена: «${after.title}»\nБыло: ${spanText(before.start, before.end, before.all_day)}\nСтало: ${spanText(after.start, after.end, after.all_day)}`,
      [[{ text: '↩️ Вернуть как было', callback_data: back }]],
    );
  }

  // ------------------------------------------------------------- lists

  /** Overdue and today's tasks of the user, numbered (the same numbers in the text and on the buttons). */
  private async myTasks(user: AuthUser) {
    const access = new BotAccess(user);
    const overdue = (await this.crm.listTasks(access, { period: 'overdue', limit: 40 })).tasks;
    const seen = new Set(overdue.map((t: any) => t.id));
    const today = (await this.crm.listTasks(access, { period: 'today', limit: 40 })).tasks.filter((t: any) => !seen.has(t.id));
    return { overdue, today, all: [...overdue, ...today] };
  }

  private async tasksPage(user: AuthUser, page: number) {
    const { all } = await this.myTasks(user);
    return { keyboard: this.pageKeyboard(all, page) };
  }

  private pageKeyboard(tasks: any[], page: number): InlineKeyboard {
    const pages = Math.max(Math.ceil(tasks.length / PAGE), 1);
    const p = Math.min(page, pages - 1);
    const now = new Date();
    const keyboard: InlineKeyboard = tasks.slice(p * PAGE, p * PAGE + PAGE).map((t, i) => [
      {
        text: taskButtonText(`${p * PAGE + i + 1}. `, { start: t.start_at, all_day: !!t.all_day, title: t.title, client: t.company ?? t.contact }, now),
        callback_data: `tk:${t.id}`,
      },
    ]);
    if (pages > 1) {
      const nav: InlineKeyboard[number] = [];
      if (p > 0) nav.push({ text: '‹ Назад', callback_data: `tp:${p - 1}` });
      if (p < pages - 1) nav.push({ text: `Ещё ${Math.min(PAGE, tasks.length - (p + 1) * PAGE)} ›`, callback_data: `tp:${p + 1}` });
      keyboard.push(nav);
    }
    return keyboard;
  }

  /**
   * Today's and overdue tasks, numbered, each with a button (time, task, client) that opens its card with
   * the actions; more than a page: «Ещё ›». As the morning digest nothing is sent when there are none.
   */
  async sendTasks(user: AuthUser, chatId: string, digest = false) {
    const { overdue, today, all } = await this.myTasks(user);
    if (!all.length) return digest ? undefined : this.send(chatId, 'На сегодня задач нет, просроченных тоже.');
    const lines: string[] = [];
    let n = 0;
    for (const [title, tasks] of [
      ['Просрочено:', overdue],
      ['На сегодня:', today],
    ] as [string, any[]][]) {
      if (!tasks.length) continue;
      lines.push(title);
      for (const t of tasks) lines.push(`${++n}. ${this.taskLine(t)}`);
      lines.push('');
    }
    lines.push('Нажмите на задачу: выполнено, перенести, изменить или удалить.');
    const intro = digest
      ? `Доброе утро, ${user.username}! У вас ${all.length} ${plural(all.length, 'задача', 'задачи', 'задач')}:\n\n`
      : '';
    return this.send(chatId, intro + lines.join('\n').trim(), this.pageKeyboard(all, 0));
  }

  taskLine(t: any) {
    const when = t.all_day ? `${t.overdue ? `${dayText(t.start_at, false)}, ` : ''}весь день` : t.overdue ? `${dayText(t.start_at, false)} ${hhmm(new Date(t.start_at))}` : hhmm(new Date(t.start_at));
    const about = [t.company ?? t.contact, t.deal_number ? `сделка №${t.deal_number}` : null, t.group ? `группа «${t.group}»` : null]
      .filter(Boolean)
      .join(', ');
    return `${when} — ${t.title}${about ? ` (${about})` : ''}`;
  }

  /**
   * Reminders of one pass to one chat: one message. A single task comes as its card with the buttons;
   * several as a numbered list with a button per task.
   */
  async sendReminder(chatId: string, me: number, tasks: TaskView[], now = new Date()) {
    if (!tasks.length) return;
    const when = (t: TaskView) => {
      const minutes = Math.round((t.start.getTime() - now.getTime()) / 60_000);
      return minutes > 0 ? `через ${minutesText(minutes)}, в ${hhmm(t.start)}` : `сейчас, в ${hhmm(t.start)}`;
    };
    if (tasks.length === 1) {
      const t = tasks[0];
      return this.send(chatId, `⏰ ${t.type} ${when(t)}:\n${this.crm.taskText(t, me)}`, this.taskKeyboard(t));
    }
    const lines = [`⏰ Скоро ${tasks.length} ${plural(tasks.length, 'задача', 'задачи', 'задач')}:`];
    tasks.forEach((t, i) => {
      const about = this.crm.aboutText(t);
      lines.push(`${i + 1}. ${t.type} ${when(t)} — «${t.title}»${about ? ` (${about})` : ''}${!t.agent_id && t.group ? `, задача группы «${t.group}»` : ''}`);
    });
    lines.push('', 'Нажмите на задачу: выполнено, перенести, изменить или удалить.');
    const keyboard: InlineKeyboard = tasks.slice(0, 20).map((t, i) => [
      { text: taskButtonText(`${i + 1}. `, { start: t.start, all_day: t.all_day, title: t.title, client: t.company ?? t.contact }, now), callback_data: `tk:${t.id}` },
    ]);
    return this.send(chatId, lines.join('\n'), keyboard);
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

  /** Sends a text (cut into Telegram-sized parts; the buttons go under the last one); returns the last message. */
  async send(chatId: string | number, text: string, keyboard?: InlineKeyboard): Promise<TgMessage | undefined> {
    if (!this.api) return undefined;
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > 4000) {
      const cutAt = Math.max(rest.lastIndexOf('\n', 4000), 2000);
      chunks.push(rest.slice(0, cutAt));
      rest = rest.slice(cutAt).trimStart();
    }
    chunks.push(rest);
    let last: TgMessage | undefined;
    for (let i = 0; i < chunks.length; i += 1) {
      last = await this.api.sendMessage(chatId, chunks[i], i === chunks.length - 1 && keyboard?.length ? keyboard : undefined);
    }
    return last;
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

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
