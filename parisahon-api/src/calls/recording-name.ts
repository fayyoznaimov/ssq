/**
 * What a call recorder tells in the name of its file. Everything is optional.
 *
 * Cube ACR, its FTP backup (seen from a real phone, 2026-11-21; a .json lies next to each file):
 *            "phone_20261120-140040__998901234567.amr"
 *            "whatsapp_20261120-154203_Textile Trading Co.amr"   (messenger calls: the name only;
 *            Cyrillic names arrive as "?????" — the .json has them right)
 * Cube ACR on the phone:
 *            "2026-11-21 14-03-12 (phone) Anvar (+998 90 123-45-67) ↗.amr"  (↗ outgoing, ↙ incoming)
 *            "2026-11-21 14-03-12 (whatsapp) Anvar.m4a"
 * Xiaomi:    "Call recording Anvar(+998901234567)_20261121_140312.mp3"
 * Samsung:   "Call recording Anvar_261121_140312.m4a"
 * Others put the number, the date and "in" / "out" in some order.
 */
export interface RecordingName {
  number: string | null;
  outgoing: boolean | null;
  // the moment of the call, in the zone of the CRM (the API runs with TZ=Asia/Karachi)
  recorded_at: Date | null;
  // "phone", "whatsapp", "telegram", ...
  app: string | null;
  // the name from the phone book of the manager, when the name of the file has one
  caller_name: string | null;
}

const APPS = [
  'phone', 'whatsapp', 'whatsapp business', 'telegram', 'viber', 'imo', 'skype', 'signal', 'line', 'wechat',
  'messenger', 'facebook', 'max', 'zoom', 'meet', 'duo', 'hangouts', 'slack', 'kakao', 'botim', 'teams', 'sip',
];
// "whatsapp_20261120-154203_Name": the app first, longer names first ("whatsapp business" before "whatsapp")
const APP_FIRST = new RegExp(`^\\s*(${[...APPS].sort((a, b) => b.length - a.length).join('|')})[_\\s-]+`, 'i');
const OUT_ARROWS = /[↗→⬈↑]/;
const IN_ARROWS = /[↙←⬋↓]/;
const LETTER = 'a-zа-яё';
const OUT_WORDS = new RegExp(`(^|[^${LETTER}])(out|outgoing|исходящий|исх)(?![${LETTER}])`, 'i');
const IN_WORDS = new RegExp(`(^|[^${LETTER}])(in|incoming|входящий|вх)(?![${LETTER}])`, 'i');
const PREFIXES = /^(call[ _-]?recording|запись[ _-]?(вызова|звонка|разговора)|вызов|звонок|recording|record|call)(?![a-zа-яё])/i;

const DATE_PATTERNS: { re: RegExp; order: 'ymd' | 'dmy' | 'short' }[] = [
  // 2026-11-21 14-03-12, 20261121_140312, 2026.11.21T14:03:12
  { re: /(?<!\d)(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _T-]{0,3}(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})(?!\d)/, order: 'ymd' },
  // 21-11-2026 14-03-12
  { re: /(?<!\d)(\d{2})[-_.](\d{2})[-_.](20\d{2})[ _T-]{0,3}(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})(?!\d)/, order: 'dmy' },
  // 261121_140312
  { re: /(?<!\d)(\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?!\d)/, order: 'short' },
];

function dateOf(parts: string[], order: 'ymd' | 'dmy' | 'short'): Date | null {
  const n = parts.map(Number);
  const [y, mo, d] = order === 'ymd' ? [n[0], n[1], n[2]] : order === 'dmy' ? [n[2], n[1], n[0]] : [2000 + n[0], n[1], n[2]];
  const [h, mi, s] = [n[3], n[4], n[5]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, s);
  return date.getMonth() === mo - 1 ? date : null;
}

/** A moment a call could have happened at: not before 2010 and not later than a day from now. */
export function plausibleCallTime(date: Date | null | undefined): Date | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() < 2010 || date.getTime() > Date.now() + 24 * 3600 * 1000) return null;
  return date;
}

export function parseRecordingName(fileName: string | null | undefined): RecordingName {
  const result: RecordingName = { number: null, outgoing: null, recorded_at: null, app: null, caller_name: null };
  let rest = String(fileName ?? '').normalize('NFC').replace(/\.[a-z0-9]{2,5}$/i, '');
  if (!rest.trim()) return result;

  if (OUT_ARROWS.test(rest)) result.outgoing = true;
  else if (IN_ARROWS.test(rest)) result.outgoing = false;
  rest = rest.replace(/[↗→⬈↑↙←⬋↓]/g, ' ');

  for (const { re, order } of DATE_PATTERNS) {
    const m = rest.match(re);
    const date = m ? plausibleCallTime(dateOf(m.slice(1), order)) : null;
    if (!m || !date) continue;
    result.recorded_at = date;
    rest = rest.replace(m[0], ' ');
    break;
  }

  const first = rest.match(APP_FIRST);
  if (first) {
    result.app = first[1].toLowerCase();
    rest = rest.slice(first[0].length);
  }
  rest = rest.replace(/\(([a-z ]{2,20})\)/gi, (whole, name: string) => {
    const app = name.trim().toLowerCase();
    if (!APPS.includes(app) || result.app) return whole;
    result.app = app;
    return ' ';
  });

  if (result.outgoing === null) {
    if (OUT_WORDS.test(rest)) result.outgoing = true;
    else if (IN_WORDS.test(rest)) result.outgoing = false;
    if (result.outgoing !== null) rest = rest.replace(result.outgoing ? OUT_WORDS : IN_WORDS, '$1 ');
  }

  // the phone number: 7..15 digits; the one in its own brackets first, with "+" first, then the longest
  const found = (re: RegExp, rank: number) =>
    [...rest.matchAll(re)].map((m) => {
      const text = m[1] ?? m[0];
      return { whole: m[0], digits: text.replace(/\D/g, ''), plus: text.startsWith('+'), rank: rank + Number(text.startsWith('+')) };
    });
  const candidates = [...found(/\(\s*(\+?\d[\d\s\-.]{5,24}\d)\s*\)/g, 2), ...found(/\+?\d[\d\s\-().]{5,24}\d/g, 0)]
    .filter((c) => c.digits.length >= 7 && c.digits.length <= 15)
    .sort((a, b) => b.rank - a.rank || b.digits.length - a.digits.length);
  if (candidates.length) {
    const best = candidates[0];
    result.number = (best.plus ? '+' : '') + best.digits;
    rest = rest.replace(best.whole, ' ');
  }

  // what is left is the name from the phone book — only in a name a recorder made (it has the
  // date, the app or "Call recording"): "audio.wav" names nobody
  const trim = (text: string) => text.replace(/^[\s\-–—.,]+|[\s\-–—.,]+$/g, '');
  const cleaned = trim(rest.replace(/[()[\]{}_]/g, ' ').replace(/\s+/g, ' '));
  const name = trim(cleaned.replace(PREFIXES, ''));
  const byRecorder = !!result.recorded_at || !!result.app || name !== cleaned;
  // "????? ???????" is a name the phone could not send: nobody
  if (byRecorder && name && /[a-zа-яё]/i.test(name)) result.caller_name = name.slice(0, 255);
  return result;
}
