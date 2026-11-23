import type { Email } from '~/types/mail';
import { sanitizeHtml } from '~/utils/sanitize';

/**
 * A letter for reading: its own text first, the quoted earlier letters folded away («Показать
 * цитату»). A text letter is cut at the reply header ("On … wrote:", "От: … Отправлено:", the tail
 * of "> " lines), the same rule as the deal history on the server (parisahon-api/src/email/mail-text.ts);
 * an HTML letter at the quote blocks of the mail programs (Gmail, Outlook, Apple Mail, Yandex, the CRM).
 */

const SEPARATOR = /^-{2,}\s*(original message|исходное сообщение|пересылаемое сообщение|forwarded message|перенаправленное сообщение|оригинальное сообщение)\s*-{2,}/i;
const WROTE = /^(on|в|во|le|am|\d).{4,300}\s(wrote|написал[аи]?(\(а\))?|пишет|écrit|schrieb|yozdi)\s*:\s*$/i;
const DATED_ADDRESS = /^.{0,80}\d{1,2}[:.]\d{2}.{0,160}(<[^>\s@]+@[^>\s]+>|[^\s@<>]+@[^\s@<>]+\.[a-z]{2,})\)?\s*:\s*$/i;
const OUTLOOK_FROM = /^\*?\s*(from|от|kimdan|от кого)\s*:\*?\s*\S/i;
const OUTLOOK_NEXT = /^\*?\s*(sent|date|отправлено|дата|yuborildi|to|кому|subject|тема)\s*:/i;

function isQuoteHeader(line: string): boolean {
    if (SEPARATOR.test(line) || DATED_ADDRESS.test(line)) return true;
    return WROTE.test(line) && (/@/.test(line) || /\d{1,2}[:.]\d{2}/.test(line) || /\b(19|20)\d{2}\b/.test(line));
}

export function splitTextQuote(text?: string | null): { main: string; quote: string } {
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

/** Quote blocks of mail programs (Gmail, Apple Mail, Thunderbird, Yahoo, Outlook web, the CRM's own). */
const QUOTE_BLOCKS = [
    '.gmail_quote', 'blockquote[type="cite"]', '.yahoo_quoted', '#divRplyFwdMsg', '#appendonsend',
    '.moz-cite-prefix', '.crm-quote', '[name="quote"]', '.OutlookMessageHeader', '.ms-outlook-mobile-reference-message',
].join(', ');

/** Cleaned HTML cut before the first quote block: what follows it (in document order) is the quote. */
export function splitHtmlQuote(cleanHtml: string): { main: string; quote: string } {
    if (!cleanHtml || typeof DOMParser === 'undefined') return { main: cleanHtml ?? '', quote: '' };
    const doc = new DOMParser().parseFromString(`<div id="crm-mail-root">${cleanHtml}</div>`, 'text/html');
    const root = doc.getElementById('crm-mail-root');
    const block = root?.querySelector(QUOTE_BLOCKS);
    if (!root || !block || !root.lastChild) return { main: cleanHtml, quote: '' };

    const range = doc.createRange();
    range.setStartBefore(block);
    range.setEndAfter(root.lastChild);
    const fragment = range.extractContents();
    const holder = doc.createElement('div');
    holder.appendChild(fragment);

    if (!(root.textContent ?? '').trim()) return { main: cleanHtml, quote: '' };
    return { main: root.innerHTML, quote: holder.innerHTML };
}

const LOOKS_HTML = /<(p|div|br|span|b|i|strong|em|ul|ol|li|table|a|blockquote)\b[^>]*>/i;

/**
 * How to show a letter: `html` (cleaned, for v-html) or plain text (for {{ }}: a text letter with
 * "Ivan <ivan@x>" must not lose the address as an unknown tag), split into its own part and the quote.
 */
export function letterView(email?: Partial<Email> | null): { html: boolean; main: string; quote: string } {
    if (!email) return { html: false, main: '', quote: '' };
    if (email.html) {
        return { html: true, ...splitHtmlQuote(sanitizeHtml(email.html)) };
    }
    const body = email.body ?? '';
    if (LOOKS_HTML.test(body)) {
        return { html: true, ...splitHtmlQuote(sanitizeHtml(body)) };
    }
    return { html: false, ...splitTextQuote(body) };
}

/** "Re: " once: a reply to "Re: Цена" stays "Re: Цена". */
export function replySubject(subject?: string | null): string {
    const text = String(subject ?? '').trim();
    return /^(re|ha|на|отв|ответ|aw|sv)\s*(\[\d+\])?\s*:/i.test(text) ? text : `Re: ${text}`;
}

const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Every address of header values like `"Name" <a@b>, c@d`, lower-cased, once each. */
export function addressesOf(values: (string | null | undefined)[]): string[] {
    const found = new Set<string>();
    for (const value of values) {
        for (const match of String(value ?? '').match(ADDRESS) ?? []) found.add(match.toLowerCase());
    }
    return [...found];
}

/** The size of files together, in MB with one decimal. */
export function megabytes(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(1);
}

/** Attachments of a letter together at most this much: the mail server takes about 25 MB with the encoding. */
export const MAX_ATTACHMENTS_MB = 20;
