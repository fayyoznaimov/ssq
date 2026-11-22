import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { DataSource } from 'typeorm';
import { Public } from '../auth/decorator/public.decorator';

/** Types a browser may be told about; everything else is sent as a plain download. */
const KNOWN_MIME = /^(video|audio|image)\/[a-z0-9.+-]+$|^application\/(pdf|zip)$/i;

/**
 * GET /telegram/remote-file/:token — a file that was too big to keep in the CRM (see
 * telegram_remote_file): fetched from Telegram through the manager's account at this moment and
 * passed to the browser as a download. Nothing is stored on the server.
 *
 * Open by link like the files in /uploads: the token is 128 random bits and is known only to
 * people who see the message in the CRM. Always an attachment, never shown inside the CRM's origin.
 */
@Public()
@Controller('telegram/remote-file')
export class TelegramRemoteFileController {
  private readonly logger = new Logger(TelegramRemoteFileController.name);
  private active = 0;

  constructor(private dataSource: DataSource) {}

  private serviceUrl(): string {
    const host = (process.env.TELEGRAM_SERVICE_HOST || '').replace(/\/+$/, '');
    const port = process.env.TELEGRAM_SERVICE_PORT;
    return port && port !== '80' && !/:\d+$/.test(host) ? `${host}:${port}` : host;
  }

  private fail(res: Response, status: number, message: string): void {
    res.status(status).type('text/plain; charset=utf-8').send(message);
  }

  @Get(':token')
  async download(@Param('token') token: string, @Res() res: Response): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(token)) return this.fail(res, 404, 'Файл не найден');
    const rows = await this.dataSource.query(
      `SELECT agent_id, chat_tg_id, tg_message_id, name, mime FROM telegram_remote_file WHERE token = $1`,
      [token],
    );
    const file = rows[0];
    if (!file) return this.fail(res, 404, 'Файл не найден');
    const base = this.serviceUrl();
    if (!base) return this.fail(res, 503, 'Telegram-сервис не настроен на сервере');
    const limit = Math.max(1, Number(process.env.TELEGRAM_REMOTE_PARALLEL || 3));
    if (this.active >= limit) {
      return this.fail(res, 429, 'Сейчас скачивается несколько больших файлов. Попробуйте через минуту.');
    }

    this.active++;
    const abort = new AbortController();
    // the browser closed the tab: stop pulling the file from Telegram
    res.on('close', () => abort.abort());
    try {
      const query = new URLSearchParams({
        user_id: String(file.agent_id),
        chat_id: String(file.chat_tg_id),
        message_id: String(file.tg_message_id),
      });
      const upstream = await fetch(`${base}/download?${query}`, { signal: abort.signal });
      if (!upstream.ok || !upstream.body) {
        const answer: any = await upstream.json().catch(() => null);
        const reason = answer?.message ? `: ${answer.message}` : '';
        return this.fail(
          res,
          upstream.status === 404 ? 404 : 502,
          `Не удалось получить файл из Telegram${reason}. Файл хранится только в Telegram: откройте переписку там.`,
        );
      }

      const mime = String(file.mime || upstream.headers.get('content-type') || '');
      const name = String(file.name || 'file').replace(/[\r\n"\\/]/g, '_');
      const ascii = name.replace(/[^\x20-\x7e]/g, '_');
      res.status(200);
      res.setHeader('Content-Type', KNOWN_MIME.test(mime) ? mime : 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      const length = upstream.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      await pipeline(Readable.fromWeb(upstream.body as any), res);
    } catch (error) {
      if (abort.signal.aborted) return;
      this.logger.warn(`remote file ${file.tg_message_id} of user ${file.agent_id}: ${(error as Error).message}`);
      if (!res.headersSent) this.fail(res, 502, 'Не удалось получить файл из Telegram. Попробуйте ещё раз.');
      else res.destroy();
    } finally {
      this.active--;
    }
  }
}
