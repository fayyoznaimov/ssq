import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { SignInDto } from './dto/sign-in.dto';
import { RoleEnum, User } from '../user/user.entity';
import { AuthUser } from './auth.guard';
import { Access, AccessSummary } from './access';
import { LoginThrottle } from './login-throttle';
import { SIGNED_OUT_EVENT, SignedOut, signOutEverywhere } from './sign-out';

/** GET /auth/access */
export type AccessResponse = AccessSummary & {
  /** staff in the user's group (the user included): whose deals the level "Для группы" covers */
  group_user_ids: number[];
};

@Injectable()
export class AuthService {
  // Compared against when the account does not exist or cannot log in, so
  // that the response time does not reveal which emails are registered.
  private static readonly DUMMY_HASH = bcrypt.hashSync('no-such-account', 10);

  // failed sign-ins per e-mail and address (see login-throttle.ts)
  private readonly throttle = new LoginThrottle();

  constructor(
    private jwtService: JwtService,
    private dataSource: DataSource,
    private events: EventEmitter2,
  ) {}

  /**
   * Signs the user out on every device and unlinks their CRM bot (POST /auth/logout, and
   * POST /auth/logout/:id by the admin). Answers 404 for an id that is not a staff account.
   */
  async logoutEverywhere(userId: number): Promise<SignedOut> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM "user" WHERE id = $1 AND deleted_at IS NULL AND role <> $2`,
      [userId, RoleEnum.CTR_AGENT],
    );
    if (!rows.length) throw new NotFoundException(`User ${userId} not found`);
    const result = await signOutEverywhere(this.dataSource, userId);
    this.events.emit(SIGNED_OUT_EVENT, result);
    return result;
  }

  /** GET /auth/access: the user's rules (Access.describe()) and the members of their group. */
  async accessOf(user: AuthUser): Promise<AccessResponse> {
    const ids = new Set<number>([user.sub]);
    if (user.group_id !== null && user.group_id !== undefined) {
      // the same set the API's "group" scope uses (access.ts scopedSql)
      const rows = await this.dataSource.query(`SELECT id FROM "user" WHERE group_id = $1 ORDER BY id`, [user.group_id]);
      for (const row of rows) ids.add(Number(row.id));
    }
    return { ...new Access(user).describe(), group_user_ids: [...ids] };
  }

  /**
   * One and the same 401 for: unknown email, wrong password, deleted account
   * and ctr_agent (customer contact records have no password and must never
   * be able to log in). The e-mail is compared without regard to case.
   * `address`: the client's address (LoginThrottle.clientAddress) for the lock of failed attempts.
   */
  async signIn(data: SignInDto, address = 'unknown'): Promise<any> {
    const key = LoginThrottle.emailKey(data.email);
    this.throttle.assertNotLocked(key, address);
    const delay = this.throttle.delayFor(key);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    const user = await this.findForLogin(data.email);

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
      this.throttle.failed(key, address);
      throw new UnauthorizedException('Invalid email or password');
    }
    this.throttle.succeeded(key, address);

    return this.generateToken(user);
  }

  /**
   * The staff account of an e-mail, with its password hash (the column is `select: false`).
   * Without regard to case (the expression index IDX_user_email_lower); an exact match wins
   * if two accounts differ only in case. Soft-deleted users and contacts are not returned.
   */
  private async findForLogin(email: unknown): Promise<User | null> {
    const wanted = typeof email === 'string' ? email.trim() : '';
    if (!wanted) return null;
    const candidates = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('t0')
      .addSelect('t0.password')
      .where('lower(t0.email) = lower(:email)', { email: wanted })
      .andWhere('t0.role <> :contact', { contact: RoleEnum.CTR_AGENT })
      .orderBy('t0.id', 'ASC')
      .take(5)
      .getMany();
    return candidates.find((candidate) => candidate.email === wanted) ?? candidates[0] ?? null;
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
