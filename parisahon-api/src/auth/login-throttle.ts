import { HttpException, HttpStatus } from '@nestjs/common';
import { Request } from 'express';

interface Failures {
  count: number;
  first: number;
  lockedUntil: number;
}

/**
 * Failed sign-ins, kept in memory (a restart forgets them; nginx also allows at most 20 attempts a
 * minute from one address).
 *  - Per e-mail AND address: MAX_FAILURES within WINDOW_MS lock that pair for LOCK_MS, the right password
 *    included. Somebody who knows a manager's e-mail (it is in the signature of every letter) locks only
 *    their own address: the manager signs in from theirs as usual.
 *  - Per e-mail from all addresses: from SLOW_AFTER failures within WINDOW_MS on, every attempt for that
 *    e-mail waits SLOW_MS before the answer. Guessing from many addresses gets slow, nobody is locked out.
 * At most MAX_ENTRIES keys: expired ones are dropped first, then the oldest unlocked ones, so a flood of
 * new keys cannot wipe the locks (the old code cleared everything above 10 000 keys).
 */
export class LoginThrottle {
  static readonly MAX_FAILURES = 8;
  static readonly WINDOW_MS = 15 * 60 * 1000;
  static readonly LOCK_MS = 15 * 60 * 1000;
  static readonly SLOW_AFTER = 20;
  static readonly SLOW_MS = 3000;
  static readonly MAX_ENTRIES = 10000;

  private readonly entries = new Map<string, Failures>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The e-mail as the key: trimmed, lower case. */
  static emailKey(email: unknown): string {
    return String(email ?? '').trim().toLowerCase();
  }

  /**
   * The client's address. The API sits behind our nginx (docker network, loopback on the dev copy),
   * which overwrites X-Real-IP with the address it saw; a request from elsewhere is taken as it is.
   */
  static clientAddress(request: Request | undefined): string {
    const remote = String(request?.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
    const real = request?.headers?.['x-real-ip'];
    if (typeof real === 'string' && real.trim() && LoginThrottle.isPrivate(remote)) return real.trim().slice(0, 64);
    return remote || 'unknown';
  }

  private static isPrivate(address: string): boolean {
    return (
      address === '' ||
      address === '::1' ||
      /^127\./.test(address) ||
      /^10\./.test(address) ||
      /^192\.168\./.test(address) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
      /^f[cd][0-9a-f]{2}:/i.test(address)
    );
  }

  private static pair(email: string, address: string): string {
    return `p:${email}|${address}`;
  }

  private static all(email: string): string {
    return `e:${email}`;
  }

  /** 429 while the pair is locked. */
  assertNotLocked(email: string, address: string): void {
    const key = LoginThrottle.pair(email, address);
    const entry = this.entries.get(key);
    if (!entry) return;
    const now = this.now();
    if (entry.lockedUntil > now) {
      const minutes = Math.ceil((entry.lockedUntil - now) / 60000);
      throw new HttpException(
        `Слишком много неудачных попыток входа. Попробуйте через ${minutes} мин.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (now - entry.first > LoginThrottle.WINDOW_MS) this.entries.delete(key);
  }

  /** How long to hold the answer for this e-mail (0: no attack on it going on). */
  delayFor(email: string): number {
    const entry = this.entries.get(LoginThrottle.all(email));
    if (!entry || this.now() - entry.first > LoginThrottle.WINDOW_MS) return 0;
    return entry.count >= LoginThrottle.SLOW_AFTER ? LoginThrottle.SLOW_MS : 0;
  }

  failed(email: string, address: string): void {
    this.count(LoginThrottle.pair(email, address), true);
    this.count(LoginThrottle.all(email), false);
    this.prune();
  }

  /** A successful sign-in clears its own pair; the e-mail-wide count runs out by itself. */
  succeeded(email: string, address: string): void {
    this.entries.delete(LoginThrottle.pair(email, address));
  }

  private count(key: string, locks: boolean): void {
    const now = this.now();
    const entry = this.entries.get(key) ?? { count: 0, first: now, lockedUntil: 0 };
    if (now - entry.first > LoginThrottle.WINDOW_MS && entry.lockedUntil <= now) {
      entry.count = 0;
      entry.first = now;
    }
    entry.count += 1;
    if (locks && entry.count >= LoginThrottle.MAX_FAILURES) entry.lockedUntil = now + LoginThrottle.LOCK_MS;
    // re-inserted: the Map keeps the order of use, the least recently used key comes first
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private prune(): void {
    if (this.entries.size <= LoginThrottle.MAX_ENTRIES) return;
    const now = this.now();
    const target = Math.floor(LoginThrottle.MAX_ENTRIES * 0.9);
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= now && now - entry.first > LoginThrottle.WINDOW_MS) this.entries.delete(key);
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= target) break;
      if (entry.lockedUntil <= now) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= target) break;
      this.entries.delete(key);
    }
  }

  /** for the checks: how many keys are kept */
  get size(): number {
    return this.entries.size;
  }
}
