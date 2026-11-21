import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { SignInDto } from './dto/sign-in.dto';
import { RoleEnum, User } from '../user/user.entity';

@Injectable()
export class AuthService {
  // Compared against when the account does not exist or cannot log in, so
  // that the response time does not reveal which emails are registered.
  private static readonly DUMMY_HASH = bcrypt.hashSync('no-such-account', 10);

  // Failed logins per e-mail (lower case), in memory: MAX_FAILURES within WINDOW_MS lock the
  // e-mail for LOCK_MS, whether the account exists or not (nginx also limits per address).
  private static readonly MAX_FAILURES = 8;
  private static readonly WINDOW_MS = 15 * 60 * 1000;
  private static readonly LOCK_MS = 15 * 60 * 1000;
  private failures = new Map<string, { count: number; first: number; lockedUntil: number }>();

  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    private dataSource: DataSource,
  ) {}

  private checkLock(key: string): void {
    const entry = this.failures.get(key);
    if (!entry) return;
    const now = Date.now();
    if (entry.lockedUntil > now) {
      const minutes = Math.ceil((entry.lockedUntil - now) / 60000);
      throw new HttpException(
        `Слишком много неудачных попыток входа. Попробуйте через ${minutes} мин.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (now - entry.first > AuthService.WINDOW_MS) this.failures.delete(key);
  }

  private recordFailure(key: string): void {
    const now = Date.now();
    const entry = this.failures.get(key) ?? { count: 0, first: now, lockedUntil: 0 };
    if (now - entry.first > AuthService.WINDOW_MS) {
      entry.count = 0;
      entry.first = now;
    }
    entry.count += 1;
    if (entry.count >= AuthService.MAX_FAILURES) entry.lockedUntil = now + AuthService.LOCK_MS;
    this.failures.set(key, entry);
    if (this.failures.size > 10000) this.failures.clear(); // never grows without bound
  }

  /** Signs the user out on every device (POST /auth/logout). */
  async logoutEverywhere(userId: number): Promise<void> {
    await this.dataSource.query(`UPDATE "user" SET token_version = token_version + 1 WHERE id = $1`, [userId]);
  }

  /**
   * One and the same 401 for: unknown email, wrong password, deleted account
   * and ctr_agent (customer contact records have no password and must never
   * be able to log in).
   */
  async signIn(data: SignInDto): Promise<any> {
    const key = String(data.email ?? '').trim().toLowerCase();
    this.checkLock(key);
    const user = await this.userService.findForLogin(data.email);

    const canLogIn =
      !!user &&
      user.role !== RoleEnum.CTR_AGENT &&
      typeof user.password === 'string' &&
      user.password.length > 0;

    const passwordMatches = await bcrypt.compare(
      data.password,
      canLogIn ? user.password : AuthService.DUMMY_HASH,
    );

    if (!canLogIn || !passwordMatches) {
      this.recordFailure(key);
      throw new UnauthorizedException('Invalid email or password');
    }
    this.failures.delete(key);

    return this.generateToken(user);
  }

  async generateToken(user: User): Promise<any> {
    return {
      access_token: await this.jwtService.signAsync({
        sub: user.id,
        tv: await this.tokenVersion(user.id),
        username: user.username,
        role: user.role,
        permissions: user.permissions,
      }),
      id: user.id,
      role: user.role,
      username: user.username,
    };
  }

  private async tokenVersion(userId: number): Promise<number> {
    const rows = await this.dataSource.query(`SELECT token_version FROM "user" WHERE id = $1`, [userId]);
    return Number(rows[0]?.token_version ?? 0);
  }
}
