import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Access } from '../auth/access';
import { AuthUser } from '../auth/auth.guard';
import { phoneKey } from '../helper/phone';

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
  // false: the user may not open this record (another manager's client): shown without a link, and
  // without its name, company and last deal date
  visible: boolean;
}

/** A condition with named parameters (Access) put into raw SQL with $n parameters. */
function bindNamed(sql: string, named: Record<string, any>, params: unknown[]): string {
  return sql.replace(/:(\w+)/g, (match, name: string) => {
    if (!(name in named)) return match;
    params.push(named[name]);
    return `$${params.length}`;
  });
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

  /**
   * `exclude_company_id`: the company being edited and its own contacts are not "similar" (its phone
   * is often its primary contact's, so the card warned about itself). The responsible manager and the
   * last deal are read for the found records only (it was two subqueries for every row of the CRM).
   * `requester`: a match the user may not open is marked `visible: false`.
   */
  async find(q: SimilarQuery, requester?: AuthUser) {
    const phone = phoneKey(q.phone) ?? '';
    const inn = digits(q.inn);
    const email = String(q.email ?? '').trim().toLowerCase();
    const domain = email.includes('@') ? email.split('@').pop() ?? '' : '';
    const companyDomain = domain && !PUBLIC_MAIL.has(domain) ? domain : '';
    const name = String(q.name ?? '').trim();

    const companies: any[] = await this.dataSource.query(
      `SELECT c.id, c.name, c.email, c.phone, c.inn FROM company c WHERE c.deleted_at IS NULL AND c.id <> $1`,
      [q.exclude_company_id ?? 0],
    );
    const contacts: any[] = await this.dataSource.query(
      `SELECT u.id, u.username AS name, u.email, u.phone, u.company_id, c.name AS company_name
         FROM "user" u LEFT JOIN company c ON c.id = u.company_id AND c.deleted_at IS NULL
        WHERE u.role = 'ctr_agent' AND u.deleted_at IS NULL AND u.id <> $1
          AND (u.company_id IS NULL OR u.company_id <> $2)`,
      [q.exclude_contact_id ?? 0, q.exclude_company_id ?? 0],
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
        agent_name: null, last_deal_at: null, visible: true,
      });
    };
    companies.forEach((r) => judge('company', r));
    contacts.forEach((r) => judge('contact', r));
    matches.sort((a, b) => (a.level === b.level ? b.reasons.length - a.reasons.length : a.level === 'same' ? -1 : 1));
    const top = matches.slice(0, 10);
    await this.describe(top, requester);

    return {
      matches: top,
      hints: { phone: phoneHint(q.phone), email: emailHint(q.email), inn: q.inn && /\s/.test(q.inn) ? `Пробелы уберём сами, сохраним как ${inn}` : null },
    };
  }

  /** Who leads the found clients (the manager of the latest deal), when the last deal was, and may the user open them. */
  private async describe(matches: SimilarMatch[], requester?: AuthUser): Promise<void> {
    const companyIds = matches.filter((m) => m.kind === 'company').map((m) => m.id);
    const contactIds = matches.filter((m) => m.kind === 'contact').map((m) => m.id);
    const info = new Map<string, { agent_name: string | null; last_deal_at: string | null }>();
    if (companyIds.length) {
      const rows: any[] = await this.dataSource.query(
        `SELECT d.company_id AS id, MAX(d.created_at) AS last_deal_at,
                (array_agg(a.username ORDER BY d.created_at DESC) FILTER (WHERE a.username IS NOT NULL))[1] AS agent_name
           FROM deal d LEFT JOIN "user" a ON a.id = d.agent_id
          WHERE d.deleted_at IS NULL AND d.company_id = ANY($1)
          GROUP BY d.company_id`,
        [companyIds],
      );
      rows.forEach((r) => info.set(`company-${r.id}`, r));
    }
    if (contactIds.length) {
      const rows: any[] = await this.dataSource.query(
        `SELECT du."userId" AS id, MAX(d.created_at) AS last_deal_at,
                (array_agg(a.username ORDER BY d.created_at DESC) FILTER (WHERE a.username IS NOT NULL))[1] AS agent_name
           FROM deal_user du JOIN deal d ON d.id = du."dealId" LEFT JOIN "user" a ON a.id = d.agent_id
          WHERE d.deleted_at IS NULL AND du."userId" = ANY($1)
          GROUP BY du."userId"`,
        [contactIds],
      );
      rows.forEach((r) => info.set(`contact-${r.id}`, r));
    }
    for (const match of matches) {
      const found = info.get(`${match.kind}-${match.id}`);
      match.agent_name = found?.agent_name ?? null;
      match.last_deal_at = found?.last_deal_at ?? null;
    }

    if (!requester) return;
    const access = new Access(requester);
    const visible = new Set<string>();
    for (const [kind, ids, alias, cond] of [
      ['company', companyIds, 'c', access.companySql('c', 'view')],
      ['contact', contactIds, 'u', access.contactSql('u', 'view')],
    ] as const) {
      if (!ids.length) continue;
      if (cond.sql === 'TRUE') {
        ids.forEach((id) => visible.add(`${kind}-${id}`));
        continue;
      }
      const params: unknown[] = [ids];
      const table = kind === 'company' ? 'company' : '"user"';
      const rows: { id: number }[] = await this.dataSource.query(
        `SELECT ${alias}.id FROM ${table} ${alias} WHERE ${alias}.id = ANY($1) AND ${bindNamed(cond.sql, cond.params, params)}`,
        params,
      );
      rows.forEach((r) => visible.add(`${kind}-${r.id}`));
    }
    for (const match of matches) {
      match.visible = visible.has(`${match.kind}-${match.id}`);
      if (match.visible) continue;
      // a record the user may not open: only that it exists, why it matches and who leads it (whom to
      // ask) — not its name, company and dates, or the list would read out another manager's clients
      match.name = match.kind === 'company' ? 'Компания другого менеджера' : 'Контакт другого менеджера';
      match.company_name = null;
      match.last_deal_at = null;
    }
  }
}
