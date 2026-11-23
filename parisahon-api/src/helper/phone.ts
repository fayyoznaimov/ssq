/**
 * One rule for the phone numbers of companies, contacts, staff and the messengers.
 *
 * - normalizePhone(raw): how a phone is STORED. "+998 (90) 123-45-67", "998901234567", "00998901234567"
 *   and "90 123 45 67" (a local Uzbek number) all become "+998901234567"; a number with another country
 *   code keeps it ("+7 912 345-67-89" -> "+79123456789"). Text that is not one clear number (letters,
 *   two numbers, an extension, a short or an ambiguous number such as "8 90 123 45 67") is kept as typed,
 *   only trimmed: nothing is guessed.
 * - phoneKey(raw): how phones are COMPARED: the last 9 digits ("901234567"); null with fewer than 9 digits.
 *   The same in SQL: phoneKeySql(column) (indexed for contacts and companies, see migration
 *   1795230000000-people-phones), so a query must build the expression with this function.
 */

/** Country code of local numbers: the CRM works in Uzbekistan. */
export const LOCAL_COUNTRY_CODE = '998';

/** Digits of a phone (anything else dropped). */
export function phoneDigits(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '');
}

/** A phone as stored: "+998901234567" style, see above. null for an empty value. */
export function normalizePhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  // one number: digits with spaces, dashes, dots and brackets, one optional "+" in front
  if (!/^\+?[\d\s\-().]+$/.test(text)) return text;
  let digits = phoneDigits(text);
  if (text.startsWith('+')) return digits.length >= 7 && digits.length <= 15 ? '+' + digits : text;
  if (digits.startsWith('00') && digits.length > 9) digits = digits.slice(2); // 00998… = +998…
  if (digits.length === 9 && !digits.startsWith('0')) return '+' + LOCAL_COUNTRY_CODE + digits;
  if (digits.length === 12 && digits.startsWith('99')) return '+' + digits; // 998 Uzbekistan, 992 / 993 / 994 / 995 / 996
  if (digits.length === 11 && digits.startsWith('7')) return '+' + digits; // Russia, Kazakhstan
  if (digits.length >= 13 && digits.length <= 15 && !digits.startsWith('0')) return '+' + digits;
  return text; // too short, or the country is not clear (8…, 10 digits): kept as typed
}

/** The part of a phone that is compared: the last 9 digits, null when there are fewer. */
export function phoneKey(raw: unknown): string | null {
  const digits = phoneDigits(raw);
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/** Two phones are the same number (by phoneKey). */
export function samePhone(a: unknown, b: unknown): boolean {
  const key = phoneKey(a);
  return key !== null && key === phoneKey(b);
}

/**
 * SQL expression of phoneKey for a column (e.g. phoneKeySql('u.phone') = :key). Written exactly like the
 * expression indexes IDX_user_phone_key / IDX_company_phone_key, so Postgres uses them.
 */
export function phoneKeySql(column: string): string {
  return `right(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 9)`;
}
