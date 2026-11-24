/**
 * The few Telegram Bot API methods the CRM bot needs, over plain fetch.
 * CRM_BOT_API_BASE points at a local stand-in in tests (local/fake-telegram).
 */
export type InlineButton = { text: string; callback_data?: string; url?: string };
export type InlineKeyboard = InlineButton[][];

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

/** voice (ogg/opus from the recorder), audio (a music/audio file), video_note (round video, mp4) */
export interface TgMedia {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: TgMedia;
  audio?: TgMedia;
  video_note?: TgMedia;
  video?: unknown;
  sticker?: unknown;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export class TelegramBotApi {
  private readonly base: string;

  constructor(
    private readonly token: string,
    base = 'https://api.telegram.org',
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const body: any = await response.json().catch(() => null);
      if (!body?.ok) {
        // never put the URL (it contains the token) into the error
        throw new TelegramApiError(`${method}: ${body?.description || `HTTP ${response.status}`}`, body?.error_code ?? response.status);
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError(`${method}: ${(error as Error)?.name === 'AbortError' ? 'timeout' : (error as Error)?.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  getMe() {
    return this.call<TgUser>('getMe');
  }

  getUpdates(offset: number, timeoutSec: number) {
    return this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
      (timeoutSec + 15) * 1000,
    );
  }

  sendMessage(chatId: number | string, text: string, keyboard?: InlineKeyboard) {
    return this.call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  editMessageText(chatId: number | string, messageId: number, text: string, keyboard?: InlineKeyboard) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard ?? [] },
    });
  }

  /** Only the buttons of a message (the text stays): the menus of a task card. */
  editMessageReplyMarkup(chatId: number | string, messageId: number, keyboard?: InlineKeyboard) {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: keyboard ?? [] },
    });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }

  sendChatAction(chatId: number | string, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<Buffer> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new TelegramApiError('getFile: no file_path');
    if (file.file_size && file.file_size > maxBytes) throw new TelegramApiError('file too large');
    const response = await fetch(`${this.base}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new TelegramApiError(`download: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new TelegramApiError('file too large');
    return buffer;
  }
}
