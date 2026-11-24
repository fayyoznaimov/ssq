import moment from "moment";
import "moment/dist/locale/ru";

/**
 * One way to show dates, sums, numbers, phones and counters everywhere in the CRM.
 *   formatDateTime(...)  «21 нояб. 2026, 18:35»
 *   formatDay(...)       «21 нояб. 2026»
 *   formatNumber(...)    «11 400 000» (thin no-break spaces between thousands)
 *   formatSum(...)       «11 400 000 ₽»
 *   plural(...)          1 сделка · 2 сделки · 5 сделок
 *   formatPhone(...)     +998 (90) 111-00-09 · +7 (925) 873-13-28
 */

/** a thin no-break space: thousands never break onto the next line */
export const THOUSANDS_SEPARATOR = String.fromCharCode(0x202f);
/** a no-break space between a sum and its currency */
const NBSP = String.fromCharCode(0xa0);
/** the currency of the CRM (constants/text.ts) */
export const CURRENCY = "₽";

export const DATE_TIME_FORMAT = "D MMM YYYY, HH:mm";
export const DATE_FORMAT = "D MMM YYYY";

type DateInput = string | number | Date | moment.Moment | null | undefined;

function toMoment(value: DateInput): moment.Moment | null {
    if (value === null || value === undefined || value === "") return null;
    // the API sends absolute moments (with a zone); they are shown in the time of the browser
    const m = moment.isMoment(value) ? value.clone() : moment(value as any);
    return m.isValid() ? m.locale("ru") : null;
}

/** «21 нояб. 2026, 18:35»; `empty` for no date */
export function formatDateTime(value: DateInput, empty = "—"): string {
    const m = toMoment(value);
    return m ? m.format(DATE_TIME_FORMAT) : empty;
}

/** «21 нояб. 2026» */
export function formatDay(value: DateInput, empty = "—"): string {
    const m = toMoment(value);
    return m ? m.format(DATE_FORMAT) : empty;
}

/**
 * The old moment formats of the tables and lists, all meaning «a date and a time» or «a day»,
 * become the two formats above (there were five: «нояб. 21-го, 18:35», «21.11.2026, 18:48:09», ...).
 */
const LEGACY_DATE_TIME = new Set(["MMM Do, HH:mm", "DD.MM.YYYY HH:mm", "DD.MM.YYYY, HH:mm", "DD.MM.YYYY HH:mm:ss", "datetime"]);
const LEGACY_DAY = new Set(["DD.MM.YYYY", "DD.MM.YY", "MMM Do", "date", "day"]);

/** a date in the format a column or a caller asked for; the old date formats give the standard ones */
export function formatDateAs(value: DateInput, format?: string, empty = "—"): string {
    if (!format || LEGACY_DATE_TIME.has(format)) return formatDateTime(value, empty);
    if (LEGACY_DAY.has(format)) return formatDay(value, empty);
    const m = toMoment(value);
    if (!m) return empty;
    return format === "calendar" ? m.calendar() : m.format(format);
}

/** «11 400 000», «1 234,5» — a number with thin spaces between thousands */
export function formatNumber(value: number | string | null | undefined, decimals = 0, empty = "—"): string {
    const n = typeof value === "string" ? Number(value) : value;
    if (n === null || n === undefined || !Number.isFinite(n)) return empty;
    const fixed = Math.abs(n).toFixed(decimals);
    const [int, frac] = fixed.split(".");
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
    const sign = n < 0 && Number(fixed) !== 0 ? "−" : "";
    return sign + grouped + (frac ? "," + frac : "");
}

/** «11 400 000 ₽» */
export function formatSum(value: number | string | null | undefined, empty = "—"): string {
    const text = formatNumber(value, 0, "");
    return text ? `${text}${NBSP}${CURRENCY}` : empty;
}

/**
 * The Russian word for a count: plural(5, "сделка", "сделки", "сделок") → «сделок».
 * Only the last two digits matter: 1, 21, 101 сделка · 2–4, 22–24 сделки · 0, 5–20, 25 сделок.
 */
export function plural(count: number, one: string, few: string, many: string): string {
    const n = Math.abs(Math.trunc(Number(count) || 0));
    const last2 = n % 100;
    const last = n % 10;
    if (last2 >= 11 && last2 <= 14) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
}

/** «5 сделок», «1 задача», «2 менеджера» */
export function countOf(count: number, one: string, few: string, many: string): string {
    return `${formatNumber(count, 0, "0")} ${plural(count, one, few, many)}`;
}

/**
 * A phone by its country code: +998 (90) 111-00-09, +7 (925) 873-13-28; other numbers are shown
 * as written (one fixed mask turned +79258731328 into «+792 (58) 731-32-8»)
 */
export function formatPhone(value: string | null | undefined, empty = ""): string {
    if (!value) return empty;
    const raw = String(value).trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("998")) {
        return `+998 (${digits.slice(3, 5)}) ${digits.slice(5, 8)}-${digits.slice(8, 10)}-${digits.slice(10)}`;
    }
    if (digits.length === 11 && (digits.startsWith("7") || (digits.startsWith("8") && !raw.startsWith("+")))) {
        return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
    }
    return raw;
}
