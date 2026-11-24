import { Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Signed, expiring links to the uploaded files (/uploads/<name>, /api/v1/uploads/<name>).
 *
 * <a href>, <img> and <audio> cannot send the login token, so a file used to open for anybody who had
 * its address, forever (a link forwarded to a messenger, left in a browser history or with someone who
 * left the company). Now every file name the API returns (the keys `path`, `avatar`, `raw_path`) carries
 * `?e=<expiry, unix seconds>&s=<hex HMAC-SHA256(name + expiry, FILE_LINK_SECRET)>`, valid for 12 hours
 * (the expiry is rounded up to the hour, so the same file keeps the same address within an hour and the
 * browser cache works). Names stored in the database stay bare: old rows are signed when they are sent.
 *
 * Checked by nginx (auth_request to GET /api/v1/files/link-check, deploy/prod/nginx.conf) and by the API
 * itself where it serves the folder (main.ts, the dev and trial copies). FILE_LINK_ENFORCE=1 refuses a
 * file without a valid signature (403); 0 (the default, for the switch-over) serves it and logs it.
 */
export type LinkVerdict = 'ok' | 'unsigned' | 'expired' | 'bad';

export class FileLink {
  static readonly TTL_SEC = 12 * 3600;
  private static readonly STEP_SEC = 3600;
  /** Response keys that hold a file name of the uploads folder. */
  static readonly KEYS = new Set(['path', 'avatar', 'raw_path']);
  /** A bare name in the uploads folder (random: 10 characters and more, no folder). */
  private static readonly NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{9,254}$/;
  /** A name with its signature, as the API returns it. */
  private static readonly SIGNED = /^([A-Za-z0-9][A-Za-z0-9._-]{9,254})\?e=(\d{1,12})&s=([0-9a-f]{64})$/;

  private static readonly logger = new Logger('FileLink');
  private static cachedSecret: Buffer | null = null;
  private static refusedInMinute = 0;
  private static minuteStarted = 0;

  /** FILE_LINK_SECRET; without it a key derived from JWT_SECRET (the same on every API process). */
  private static secret(): Buffer {
    if (FileLink.cachedSecret) return FileLink.cachedSecret;
    const own = (process.env.FILE_LINK_SECRET ?? '').trim();
    const jwt = (process.env.JWT_SECRET ?? '').trim();
    if (own) {
      FileLink.cachedSecret = Buffer.from(own, 'utf8');
    } else if (jwt) {
      FileLink.cachedSecret = createHmac('sha256', jwt).update('parisa-file-links').digest();
    } else {
      // no secret at all (a test run): links work until the API restarts
      FileLink.logger.warn('neither FILE_LINK_SECRET nor JWT_SECRET is set: file links last until the restart');
      FileLink.cachedSecret = randomBytes(32);
    }
    return FileLink.cachedSecret;
  }

  static enforced(): boolean {
    return (process.env.FILE_LINK_ENFORCE ?? '').trim() === '1';
  }

  private static mac(name: string, expires: number): string {
    return createHmac('sha256', FileLink.secret()).update(name + String(expires)).digest('hex');
  }

  /** "abc.pdf" -> "abc.pdf?e=…&s=…" (12 to 13 hours ahead); anything else is returned unchanged. */
  static sign(value: string, nowMs = Date.now()): string {
    if (!FileLink.NAME.test(value)) return value;
    const now = Math.floor(nowMs / 1000);
    const expires = Math.ceil((now + FileLink.TTL_SEC) / FileLink.STEP_SEC) * FileLink.STEP_SEC;
    return `${value}?e=${expires}&s=${FileLink.mac(value, expires)}`;
  }

  /** A signed name sent back by the client ("abc.pdf?e=…&s=…") -> "abc.pdf". */
  static strip(value: string): string {
    const m = FileLink.SIGNED.exec(value);
    return m ? m[1] : value;
  }

  static verify(name: string, expires: string | null | undefined, signature: string | null | undefined, nowMs = Date.now()): LinkVerdict {
    if (!expires && !signature) return 'unsigned';
    if (!expires || !signature || !/^\d{1,12}$/.test(expires) || !/^[0-9a-f]{64}$/.test(signature)) return 'bad';
    const expected = Buffer.from(FileLink.mac(name, Number(expires)), 'hex');
    const given = Buffer.from(signature, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'bad';
    return Number(expires) * 1000 < nowMs ? 'expired' : 'ok';
  }

  /**
   * The verdict on a requested address ("/api/v1/uploads/<name>?e=…&s=…" as nginx passes it in
   * X-Original-URI, or req.originalUrl in the API). An address outside /uploads is 'bad'.
   */
  static checkUri(uri: string, nowMs = Date.now()): { verdict: LinkVerdict; name: string } {
    let url: URL;
    try {
      url = new URL(uri || '', 'http://local');
    } catch {
      return { verdict: 'bad', name: '' };
    }
    const m = /^\/(?:api\/v1\/)?uploads\/(.+)$/.exec(url.pathname);
    if (!m) return { verdict: 'bad', name: '' };
    let name: string;
    try {
      name = decodeURIComponent(m[1]);
    } catch {
      return { verdict: 'bad', name: m[1] };
    }
    return { verdict: FileLink.verify(name, url.searchParams.get('e'), url.searchParams.get('s'), nowMs), name };
  }

  /**
   * Whether a request for a file may be served: a valid signature always; anything else only while
   * FILE_LINK_ENFORCE is not 1 (then it is logged — at most one line a minute with a count).
   */
  static allows(uri: string, nowMs = Date.now()): boolean {
    const { verdict, name } = FileLink.checkUri(uri, nowMs);
    if (verdict === 'ok') return true;
    const enforced = FileLink.enforced();
    FileLink.note(verdict, name, enforced, nowMs);
    return !enforced;
  }

  private static note(verdict: LinkVerdict, name: string, enforced: boolean, nowMs: number): void {
    if (nowMs - FileLink.minuteStarted >= 60_000) {
      if (FileLink.refusedInMinute > 1) {
        FileLink.logger.warn(`${FileLink.refusedInMinute - 1} more file requests without a valid link in the last minute`);
      }
      FileLink.minuteStarted = nowMs;
      FileLink.refusedInMinute = 0;
    }
    FileLink.refusedInMinute++;
    if (FileLink.refusedInMinute === 1) {
      const shown = name.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 80);
      FileLink.logger.warn(
        `file ${shown || '(none)'}: link ${verdict}${enforced ? ', refused (FILE_LINK_ENFORCE=1)' : ', served (FILE_LINK_ENFORCE is not 1)'}`,
      );
    }
  }

  /**
   * A copy of an API answer with every file name signed (keys `path`, `avatar`, `raw_path`). Made the
   * way the answer is sent anyway (JSON), so the objects of the handler (and any cache) are not changed.
   */
  static signDeep<T>(data: T, nowMs = Date.now()): T {
    if (data === null || data === undefined || typeof data !== 'object') return data;
    if (Buffer.isBuffer(data) || typeof (data as any).pipe === 'function' || typeof (data as any).getStream === 'function') return data;
    let touched = false;
    const json = JSON.stringify(data, function (key, value) {
      if (typeof value === 'string' && FileLink.KEYS.has(key)) {
        const signed = FileLink.sign(value, nowMs);
        if (signed !== value) touched = true;
        return signed;
      }
      return value;
    });
    return touched && json !== undefined ? JSON.parse(json) : data;
  }

  /** A request body: signed names the client sends back (a contact's avatar, a file of a message) lose the signature. */
  static stripDeep(body: unknown, depth = 0): void {
    if (!body || typeof body !== 'object' || depth > 12 || Buffer.isBuffer(body)) return;
    if (Array.isArray(body)) {
      for (const item of body) FileLink.stripDeep(item, depth + 1);
      return;
    }
    const record = body as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (typeof value === 'string') {
        if (FileLink.KEYS.has(key)) record[key] = FileLink.strip(value);
      } else {
        FileLink.stripDeep(value, depth + 1);
      }
    }
  }
}
