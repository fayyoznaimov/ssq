import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * "Похоже, такой клиент уже есть": companies and contacts that look like the one being typed.
 *
 * - phone: digits only, the last 9 compared (+998 90 123-45-67 = 998901234567 = 901234567);
 * - INN: digits only, equal;
 * - e-mail: the same address, or the same company domain (public mail services excluded);
 * - name: without legal forms (ООО, LLC, MChJ ...), quotes, punctuation and case, Cyrillic read as Latin,
 *   compared with a tolerance for typos (edit distance) and by words.
 * Plus hints in plain words: a phone with a wrong number of digits, a likely typo in an e-mail domain.
 */
export interface SimilarQuery {
  name?: string;
  phone?: string;
  email?: string;
  inn?: string;
  exclude_company_id?: number;
  exclude_contact_id?: number;
}

export interface SimilarMatch {
  kind: 'company' | 'contact';
  id: number;
  name: string;
  company_id: number | null;
  company_name: string | null;
  level: 'same' | 'possible';
  reasons: string[];
  agent_name: string | null;
  last_deal_at: string | null;
}

const LEGAL = [
  'ооо', 'оао', 'зао', 'ао', 'пао', 'ип', 'чп', 'ооо.', 'ltd', 'llc', 'inc', 'co', 'corp', 'gmbh', 'jsc', 'mchj', 'xk',
  'ok', 'aj', 'ooo', 'oao', 'zao', 'ip', 'mchj.', 'qk', 'fx', 'ajk', 'компания', 'company', 'firma', 'фирма',
];
const PUBLIC_MAIL = new Set([
  'gmail.com', 'mail.ru', 'yandex.ru', 'ya.ru', 'yandex.com', 'inbox.ru', 'list.ru', 'bk.ru', 'outlook.com',
  'hotmail.com', 'yahoo.com', 'icloud.com', 'rambler.ru', 'umail.uz', 'proton.me', 'protonmail.com', 'live.com',
]);
const TLD_FIX: Record<string, string> = { con: 'com', cmo: 'com', ocm: 'com', comm: 'com', ry: 'ru', rru: 'ru', ur: 'ru', zu: 'uz', yz: 'uz' };
const DOMAIN_FIX: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gnail.com': 'gmail.com',
  'mail.ry': 'mail.ru', 'mial.ru': 'mail.ru', 'yandex.ry': 'yandex.ru', 'yndex.ru': 'yandex.ru',
};

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya', қ: 'k', ғ: 'g', ҳ: 'h', ў: 'u',
};

export function digits(value: string | null | undefined): string {
  return String(value ?? '').replace(/\D/g, '');
}

/** Words of a name: lower case, Latin letters, without legal forms and punctuation. */
export function nameWords(value: string | null | undefined): string[] {
  const lower = String(value ?? '').toLowerCase().replace(/[«»"'`“”„]/g, ' ');
  const latin = [...lower].map((ch) => CYR[ch] ?? ch).join('')
    .replace(/kh/g, 'h').replace(/ks/g, 'x').replace(/w/g, 'v').replace(/ph/g, 'f').replace(/ck/g, 'k');
  return latin
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !LEGAL.includes(w));
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** 0..1: how alike two names are (1 = the same after normalisation). */
export function nameSimilarity(a: string, b: string): number {
  const wa = nameWords(a), wb = nameWords(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const ja = wa.join(''), jb = wb.join('');
  if (ja === jb) return 1;
  // "Компания 1" and "Компания 2", "Склад 5" and "Склад": different numbers are different clients
  const na = wa.filter((w) => /\d/.test(w)).sort().join(' '), nb = wb.filter((w) => /\d/.test(w)).sort().join(' ');
  if (na !== nb) return 0.5;
  const whole = 1 - editDistance(ja, jb) / Math.max(ja.length, jb.length);
  // words: every word of the shorter name has a close word in the longer one
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const close = short.filter((w) => long.some((x) => x === w || (w.length >= 4 && editDistance(w, x) <= (w.length >= 8 ? 2 : 1)))).length;
  const words = close / short.length;
  return Math.max(whole, words * 0.95);
}

export function phoneHint(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  const d = digits(value);
  if (/[a-zA-Zа-яА-Я]/.test(value)) return 'В номере есть буквы. Нужен вид +998 90 123 45 67';
  if (d.startsWith('998')) {
    if (d.length < 12) return `В номере не хватает ${12 - d.length === 1 ? 'одной цифры' : `${12 - d.length} цифр`}. Нужен вид +998 90 123 45 67`;
    if (d.length > 12) return 'В номере лишние цифры. Нужен вид +998 90 123 45 67';
    return null;
  }
  // other countries the company sells to: Russia / Kazakhstan (+7, 11 digits), Tajikistan, Kyrgyzstan, Turkmenistan
  if (d.length === 11 && d.startsWith('7')) return null;
  if (d.length === 12 && /^(992|996|993|994|995)/.test(d)) return null;
  if (d.length === 9) return 'Не указан код страны. Для Узбекистана: +998 и 9 цифр';
  if (d.startsWith('8') && d.length >= 10) return 'Номер начинается с 8. Для Узбекистана нужен вид +998 90 123 45 67';
  if (d.length < 9) return 'Слишком короткий номер. Нужен вид +998 90 123 45 67';
  if (d.length > 15) return 'Слишком длинный номер';
  return null;
}

export function emailHint(value: string | undefined): string | null {
  if (!value || !value.includes('@')) return null;
  const domain = value.trim().toLowerCase().split('@').pop() ?? '';
  if (DOMAIN_FIX[domain]) return `Возможно, опечатка: «${domain}». Вы имели в виду «${DOMAIN_FIX[domain]}»?`;
  const parts = domain.split('.');
  const tld = parts[parts.length - 1];
  if (parts.length > 1 && TLD_FIX[tld]) {
    return `Возможно, опечатка: «.${tld}». Вы имели в виду «.${TLD_FIX[tld]}»?`;
  }
  return null;
}

@Injectable()
export class SimilarService {
  constructor(private dataSource: DataSource) {}

  async find(q: SimilarQuery) {
    const phone = digits(q.phone).slice(-9);
    const inn = digits(q.inn);
    const email = String(q.email ?? '').trim().toLowerCase();
    const domain = email.includes('@') ? email.split('@').pop() ?? '' : '';
    const companyDomain = domain && !PUBLIC_MAIL.has(domain) ? domain : '';
    const name = String(q.name ?? '').trim();

    const companies: any[] = await this.dataSource.query(
      `SELECT c.id, c.name, c.email, c.phone, c.inn,
              (SELECT u.username FROM deal d JOIN "user" u ON u.id = d.agent_id
                WHERE d.company_id = c.id AND d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 1) AS agent_name,
              (SELECT MAX(d.created_at) FROM deal d WHERE d.company_id = c.id AND d.deleted_at IS NULL) AS last_deal_at
         FROM company c WHERE c.deleted_at IS NULL AND c.id <> $1`,
      [q.exclude_company_id ?? 0],
    );
    const contacts: any[] = await this.dataSource.query(
      `SELECT u.id, u.username AS name, u.email, u.phone, u.company_id, c.name AS company_name,
              (SELECT a.username FROM deal_user du JOIN deal d ON d.id = du."dealId" JOIN "user" a ON a.id = d.agent_id
                WHERE du."userId" = u.id AND d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 1) AS agent_name,
              (SELECT MAX(d.created_at) FROM deal_user du JOIN deal d ON d.id = du."dealId"
                WHERE du."userId" = u.id AND d.deleted_at IS NULL) AS last_deal_at
         FROM "user" u LEFT JOIN company c ON c.id = u.company_id
        WHERE u.role = 'ctr_agent' AND u.deleted_at IS NULL AND u.id <> $1`,
      [q.exclude_contact_id ?? 0],
    );

    const matches: SimilarMatch[] = [];
    const judge = (kind: 'company' | 'contact', r: any) => {
      const reasons: string[] = [];
      let strong = 0, weak = 0;
      if (kind === 'company' && inn.length >= 6 && digits(r.inn) === inn) { reasons.push(`Совпадает ИНН ${inn}`); strong++; }
      if (phone.length === 9 && digits(r.phone).slice(-9) === phone) { reasons.push('Совпадает телефон'); strong++; }
      const rEmail = String(r.email ?? '').toLowerCase();
      if (email && rEmail === email) { reasons.push('Совпадает почта'); strong++; }
      else if (companyDomain && rEmail.endsWith('@' + companyDomain)) { reasons.push(`Почта на том же домене ${companyDomain}`); weak++; }
      if (name.length >= 3) {
        const sim = nameSimilarity(name, r.name);
        if (sim >= 0.999) { reasons.push(/[a-z]/i.test(name) !== /[a-z]/i.test(r.name) ? 'То же название, другой алфавит' : 'То же название'); strong++; }
        else if (sim >= 0.8) { reasons.push('Очень похожее название'); weak += 2; }
        else if (sim >= 0.65) { reasons.push('Похожее название'); weak++; }
      }
      if (strong === 0 && weak === 0) return;
      matches.push({
        kind, id: r.id, name: r.name, company_id: kind === 'company' ? r.id : r.company_id ?? null,
        company_name: kind === 'company' ? r.name : r.company_name ?? null,
        level: strong > 0 ? 'same' : 'possible', reasons,
        agent_name: r.agent_name ?? null, last_deal_at: r.last_deal_at ?? null,
      });
    };
    companies.forEach((r) => judge('company', r));
    contacts.forEach((r) => judge('contact', r));
    matches.sort((a, b) => (a.level === b.level ? b.reasons.length - a.reasons.length : a.level === 'same' ? -1 : 1));

    return {
      matches: matches.slice(0, 10),
      hints: { phone: phoneHint(q.phone), email: emailHint(q.email), inn: q.inn && /\s/.test(q.inn) ? `Пробелы уберём сами, сохраним как ${inn}` : null },
    };
  }
}
