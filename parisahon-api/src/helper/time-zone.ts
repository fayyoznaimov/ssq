/**
 * The one time zone of the CRM (DB-1 / HACK-3 / SEC-17): the API process (local getters of Date, «сегодня»,
 * working hours), its database sessions (datasource.ts) and the default of the database itself (migration
 * 1795720000000-database-time-zone) all use it, so a time the API writes and a time the database fills
 * (created_at, now()) are on the same clock.
 *
 * It is the environment's TZ, Asia/Tashkent by default (the company's zone, UTC+5 — the same offset as the
 * Asia/Karachi used before). A name Node does not know is not used silently (Node would fall back to UTC and
 * the database would refuse the connection): the default is used instead, with a warning.
 * Importing this file sets process.env.TZ, so whatever loads it first (main.ts, the TypeORM CLI through
 * datasource.ts) runs in the zone.
 */
export const DEFAULT_TIME_ZONE = 'Asia/Tashkent';

/** The name when it is a time zone Node knows (IANA, e.g. Asia/Tashkent, UTC), otherwise null. */
export function knownTimeZone(name: string | null | undefined): string | null {
  const zone = String(name ?? '').trim();
  // letters, digits and / _ + - only: the name goes into SQL of the migrations and the connection options
  if (!zone || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function resolveTimeZone(): string {
  const given = process.env.TZ;
  const zone = knownTimeZone(given);
  if (!zone && given) {
    // console: the Nest logger is not there yet when the TypeORM CLI or main.ts loads this
    console.warn(`TZ=${given} is not a known time zone: ${DEFAULT_TIME_ZONE} is used`);
  }
  return zone ?? DEFAULT_TIME_ZONE;
}

/** The zone of the CRM: TZ of the environment (when known) or Asia/Tashkent. */
export const APP_TIME_ZONE = resolveTimeZone();
process.env.TZ = APP_TIME_ZONE;
