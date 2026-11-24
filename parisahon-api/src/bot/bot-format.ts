/**
 * Texts of the bot about tasks: dates with the weekday, Russian plurals, button labels and the
 * dates a manager types («завтра 15:00», «25.11 10:30», «пт 9:00»). The server runs in the CRM's
 * time zone (TZ, Asia/Tashkent by default), so the local getters of Date are the manager's local time.
 */

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WEEKDAY_WORDS: Record<string, number> = {
  вс: 0, воскресенье: 0, вск: 0,
  пн: 1, понедельник: 1, пнд: 1,
  вт: 2, вторник: 2,
  ср: 3, среда: 3, среду: 3,
  чт: 4, четверг: 4,
  пт: 5, пятница: 5, пятницу: 5,
  сб: 6, суббота: 6, субботу: 6, сбт: 6,
};

const p2 = (n: number) => String(n).padStart(2, '0');

/** plural(5, 'задача', 'задачи', 'задач') -> "задач" */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** 1 -> "1 минуту", 3 -> "3 минуты", 15 -> "15 минут" (after «через») */
export function minutesText(n: number): string {
  return `${n} ${plural(n, 'минуту', 'минуты', 'минут')}`;
}

export function clip(text: unknown, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function hhmm(d: Date): string {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "вт 24.11.2026" (the year only when it is not the current one, unless `year`) */
export function dayText(value: Date | string, year = true, now = new Date()): string {
  const d = new Date(value);
  const withYear = year || d.getFullYear() !== now.getFullYear();
  return `${WEEKDAYS[d.getDay()]} ${p2(d.getDate())}.${p2(d.getMonth() + 1)}${withYear ? `.${d.getFullYear()}` : ''}`;
}

/** "вт 24.11.2026 15:00–16:00", "вт 24.11.2026, весь день" */
export function spanText(start: Date | string, end: Date | string | null, allDay: boolean): string {
  const from = new Date(start);
  if (allDay) {
    const till = end ? new Date(end) : from;
    return sameDay(from, till) ? `${dayText(from)}, весь день` : `${dayText(from)} – ${dayText(till)}, весь день`;
  }
  if (!end) return `${dayText(from)} ${hhmm(from)}`;
  const till = new Date(end);
  if (till.getTime() <= from.getTime()) return `${dayText(from)} ${hhmm(from)}`;
  return sameDay(from, till) ? `${dayText(from)} ${hhmm(from)}–${hhmm(till)}` : `${dayText(from)} ${hhmm(from)} – ${dayText(till)} ${hhmm(till)}`;
}

/** Short time for a button: "15:00" today, "завтра 15:00", "пт 27.11 15:00"; all-day tasks without the time. */
export function shortWhen(start: Date | string, allDay: boolean, now = new Date()): string {
  const d = new Date(start);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let day = '';
  if (sameDay(d, now)) day = allDay ? 'сегодня' : '';
  else if (sameDay(d, tomorrow)) day = 'завтра';
  else day = dayText(d, false, now);
  return [day, allDay ? '' : hhmm(d)].filter(Boolean).join(' ');
}

/** A task button: "1. 15:00 Позвонить по оплате · Текстиль" in at most 60 characters. */
export function taskButtonText(prefix: string, t: { start: Date | string; all_day: boolean; title: string; client?: string | null }, now = new Date()) {
  const when = shortWhen(t.start, t.all_day, now);
  const head = `${prefix}${when ? `${when} ` : ''}`;
  const client = t.client ? clip(t.client, 22) : '';
  const room = 60 - head.length - (client ? client.length + 3 : 0);
  const title = clip(t.title, Math.max(room, 12));
  return clip(`${head}${title}${client ? ` · ${client}` : ''}`, 60);
}

export interface ParsedWhen {
  /** local start */
  start: Date;
  /** no time was given: keep the task's own time of day (or all day) */
  dateOnly: boolean;
  /** only a time was given (no day) */
  timeOnly: boolean;
}

/**
 * A date and/or time typed by a manager, the whole message: «завтра 15:00», «послезавтра»,
 * «сегодня в 18:30», «25.11 10:30», «25.11.2026», «пт 9:00», «в пятницу 9:00», «15:30»,
 * «через 2 часа», «через 30 минут», «через 3 дня». Null when the text is not a date.
 */
export function parseWhen(input: string, now = new Date()): ParsedWhen | null {
  let s = input.toLowerCase().replace(/ё/g, 'е').replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const rel = /^через (\d{1,3}|полчаса|час|день|неделю)\s*(минут[уы]?|мин|час(?:а|ов)?|ч|д(?:ня|ней|ень)?|недел[июь]+)?$/.exec(s);
  if (rel) {
    const word = rel[1];
    const unit = rel[2] ?? '';
    let ms: number | null = null;
    if (word === 'полчаса') ms = 30 * 60_000;
    else if (word === 'час') ms = 3600_000;
    else if (word === 'день') ms = 86400_000;
    else if (word === 'неделю') ms = 7 * 86400_000;
    else {
      const n = Number(word);
      if (/^мин/.test(unit)) ms = n * 60_000;
      else if (/^ч/.test(unit)) ms = n * 3600_000;
      else if (/^д/.test(unit)) ms = n * 86400_000;
      else if (/^недел/.test(unit)) ms = n * 7 * 86400_000;
    }
    if (ms === null || ms <= 0 || ms > 400 * 86400_000) return null;
    const at = new Date(now.getTime() + ms);
    at.setSeconds(0, 0);
    const days = /^(д|недел)/.test(unit) || word === 'день' || word === 'неделю';
    return { start: at, dateOnly: days, timeOnly: false };
  }

  // the time, at the end: "15:00", "в 15:00", "завтра 15.30" (not when the whole text is a date "25.11")
  let hours: number | null = null;
  let minutes = 0;
  const DATE = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/;
  const wholeDate = DATE.exec(s);
  const isDate = !!wholeDate && Number(wholeDate[1]) >= 1 && Number(wholeDate[1]) <= 31 && Number(wholeDate[2]) >= 1 && Number(wholeDate[2]) <= 12;
  const time = isDate ? null : /(?:^|\s)(?:в\s)?(\d{1,2})[:.](\d{2})$/.exec(s);
  if (time) {
    hours = Number(time[1]);
    minutes = Number(time[2]);
    if (hours > 23 || minutes > 59) return null;
    s = s.slice(0, time.index).trim();
  } else if (!isDate) {
    const bare = /(?:^|\s)в\s(\d{1,2})$/.exec(s);
    if (bare) {
      hours = Number(bare[1]);
      if (hours > 23) return null;
      s = s.slice(0, bare.index).trim();
    }
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let day: Date | null = null;
  if (!s) {
    if (hours === null) return null;
    day = today;
  } else if (s === 'сегодня') day = today;
  else if (s === 'завтра') day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  else if (s === 'послезавтра') day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
  else {
    const dm = DATE.exec(s);
    const word = s in WEEKDAY_WORDS ? s : s.replace(/^во?\s+/, '');
    if (dm) {
      const d = Number(dm[1]);
      const m = Number(dm[2]);
      let y = dm[3] ? Number(dm[3]) : today.getFullYear();
      if (y < 100) y += 2000;
      let candidate = new Date(y, m - 1, d);
      if (candidate.getMonth() !== m - 1 || candidate.getDate() !== d) return null;
      // "05.01" typed in December is next January
      if (!dm[3] && candidate.getTime() < today.getTime() - 60 * 86400_000) candidate = new Date(y + 1, m - 1, d);
      day = candidate;
    } else if (word in WEEKDAY_WORDS) {
      const target = WEEKDAY_WORDS[word];
      let ahead = (target - today.getDay() + 7) % 7;
      // "пт 18:00" on a Friday morning is today; "пт" alone or a time already past is the next Friday
      if (ahead === 0 && !(hours !== null && hours * 60 + minutes > now.getHours() * 60 + now.getMinutes())) ahead = 7;
      day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ahead);
    } else {
      return null;
    }
  }
  if (hours === null) return { start: day, dateOnly: true, timeOnly: false };
  return { start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes), dateOnly: false, timeOnly: !s };
}
