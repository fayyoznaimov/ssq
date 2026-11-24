/**
 * Text helpers of the mail module (no Nest, no database): what Postgres takes, the plain text of an
 * HTML letter, a reply without the quoted earlier letters, addresses and Message-IDs of headers.
 */

/** Postgres text and jsonb do not take NUL (0x00): one such character used to stop the whole sync. */
export function noNul<T extends string | null | undefined>(value: T): T {
  return (typeof value === 'string' ? value.replace(/\u0000/g, '') : value) as T;
}

/** A name for the varchar(255) column of a file: no NUL, at most 255 characters, the extension kept. */
export function safeFileName(name: string | null | undefined, fallback = 'attachment'): string {
  const clean = noNul(String(name ?? '')).replace(/[\r\n\t]+/g, ' ').trim() || fallback;
  if (clean.length <= 255) return clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 && clean.length - dot <= 17 ? clean.slice(dot) : '';
  return clean.slice(0, 255 - extension.length) + extension;
}

/** At most `max` characters, NUL removed (subject, from name: varchar / text columns). */
export function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return noNul(String(value)).slice(0, max);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', times: '×', bull: '•',
};

function decodeEntity(entity: string): string | null {
  if (entity[0] === '#') {
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : null;
  }
  return NAMED_ENTITIES[entity.toLowerCase()] ?? null;
}

/** The plain text of an HTML fragment: paragraphs and line breaks kept, tags and entities gone. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const text = String(html)
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|ul|ol)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    // cells of a table apart: «Полотенце 50x90 | 300 | 12 500 сум», not «50x9030012 500 сум»
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => decodeEntity(entity) ?? match);
  return noNul(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t ]{2,}/g, ' ')
    // the separator after the last cell of a row
    .replace(/[ \t]*\|[ \t]*(?=\n|$)/g, '')
    .trim();
}

export function escapeText(text: string | null | undefined): string {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Plain text as HTML for a letter: escaped, line breaks kept. */
export function textToHtml(text: string | null | undefined): string {
  return escapeText(text).replace(/\r\n?|\n/g, '<br>');
}

/** The line that starts the quoted earlier letter of a reply (Gmail, Outlook, Apple Mail, Yandex, Mail.ru). */
const SEPARATOR = /^-{2,}\s*(original message|исходное сообщение|пересылаемое сообщение|forwarded message|перенаправленное сообщение|оригинальное сообщение)\s*-{2,}/i;
// "On Mon, 1 Jan 2026 at 10:00, Ivan <ivan@x> wrote:", "20 нояб. 2026 г., в 10:00, Ivan <ivan@x> написал(а):",
// "20.11.2026 10:00, Ivan пишет:"
const WROTE = /^(on|в|во|le|am|\d).{4,300}\s(wrote|написал[аи]?(\(а\))?|пишет|écrit|schrieb|yozdi)\s*:\s*$/i;
// "пн, 20 нояб. 2026 г. в 10:00, Ivan <ivan@x>:" (Gmail in Russian, Yandex, Mail.ru)
const DATED_ADDRESS = /^.{0,80}\d{1,2}[:.]\d{2}.{0,160}(<[^>\s@]+@[^>\s]+>|[^\s@<>]+@[^\s@<>]+\.[a-z]{2,})\)?\s*:\s*$/i;

function isQuoteHeader(line: string): boolean {
  if (SEPARATOR.test(line) || DATED_ADDRESS.test(line)) return true;
  // "В понедельник клиент написал:" is text: the header carries a time, a year or an address
  return WROTE.test(line) && (/@/.test(line) || /\d{1,2}[:.]\d{2}/.test(line) || /\b(19|20)\d{2}\b/.test(line));
}
const OUTLOOK_FROM = /^\*?\s*(from|от|kimdan|от кого)\s*:\*?\s*\S/i;
const OUTLOOK_NEXT = /^\*?\s*(sent|date|отправлено|дата|yuborildi|to|кому|subject|тема)\s*:/i;

/**
 * A received letter as its own text and the quoted earlier letters under it. Each reply carries the
 * whole thread, so in the deal history (where the earlier letters are entries of their own) only the
 * first part is shown. A letter that is nothing but a quote (a forward) keeps its text.
 */
export function splitQuote(text: string | null | undefined): { main: string; quote: string } {
  const all = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = all.split('\n');
  let start = -1;

  for (let i = 0; i < lines.length && start < 0; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (isQuoteHeader(line)) start = i;
    else if (/^_{20,}$/.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_FROM.test(l.trim()))) start = i;
    else if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 6).filter((l) => OUTLOOK_NEXT.test(l.trim())).length >= 2) start = i;
  }

  // the tail of "> " lines
  if (start < 0) {
    let tail = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line.startsWith('>')) tail = line ? i : tail;
      else break;
    }
    if (tail < lines.length && lines.slice(tail).some((l) => l.trim().startsWith('>'))) start = tail;
  }

  if (start <= 0) return { main: all.trim(), quote: '' };
  const main = lines.slice(0, start).join('\n').trim();
  if (!main) return { main: all.trim(), quote: '' };
  return { main, quote: lines.slice(start).join('\n').trim() };
}

const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Every address in header values like `"Name" <a@b>, c@d`, lower-cased, once each. */
export function addressesIn(values: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const value of values) {
    for (const match of String(value ?? '').match(ADDRESS) ?? []) found.add(match.toLowerCase());
  }
  return [...found];
}

export function domainOf(address: string | null | undefined): string {
  const at = String(address ?? '').lastIndexOf('@');
  return at >= 0 ? String(address).slice(at + 1).toLowerCase() : '';
}

/** Public mail services: their domain says nothing about the client's company. */
const FREE_MAIL = new Set(
  ('gmail.com googlemail.com mail.ru bk.ru list.ru inbox.ru internet.ru yandex.ru yandex.com yandex.uz ya.ru ' +
    'rambler.ru outlook.com hotmail.com live.com msn.com icloud.com me.com mac.com yahoo.com ymail.com aol.com ' +
    'protonmail.com proton.me gmx.com gmx.de gmx.net zoho.com qq.com 163.com 126.com umail.uz inbox.uz mail.uz ' +
    'example.com example.test').split(' '),
);

export function isFreeMail(address: string | null | undefined): boolean {
  const domain = domainOf(address);
  return !domain || FREE_MAIL.has(domain);
}

/** "ivan.petrov@x" -> "Ivan Petrov": a starting point for the name of a contact, not the truth. */
export function nameFromAddress(address: string | null | undefined): string {
  const local = String(address ?? '').split('@')[0] ?? '';
  const name = local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
  return name || String(address ?? '');
}

/** A Message-ID in the form the headers use: `<id@host>`, or null. */
export function messageIdOf(value: string | null | undefined): string | null {
  const raw = noNul(String(value ?? '')).trim();
  if (!raw) return null;
  const id = raw.startsWith('<') ? raw : `<${raw.replace(/>$/, '')}>`;
  return id.slice(0, 998);
}

/** Message-IDs of a References / In-Reply-To header (mailparser gives a string or a list). */
export function messageIdsIn(value: string | string[] | null | undefined): string[] {
  const text = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  const ids = text.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids.map((id) => id.slice(0, 998)))];
}

/** "Re: " once: a reply to "Re: Цена" stays "Re: Цена". */
export function replySubject(subject: string | null | undefined): string {
  const text = String(subject ?? '').trim();
  return /^(re|ha|на|отв|ответ|aw|sv)\s*(\[\d+\])?\s*:/i.test(text) ? text : `Re: ${text}`;
}
