import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { RoleEnum, User, UserPermissions } from '../user/user.entity';
import { Roles } from './decorator/roles.decorator';
import { IS_PUBLIC_KEY } from './decorator/public.decorator';

/**
 * What ends up in `request.user` (http) / `client.user` (websocket).
 * `sub` and `exp` come from the token, everything else is re-read from the
 * database on every request, so a role change or a deleted account takes
 * effect immediately and not when the 24h token expires.
 */
export interface AuthUser {
  sub: number;
  username: string;
  role: RoleEnum;
  permissions: UserPermissions | null;
  group_id: number | null;
  exp?: number;
}

// Marks a request that this guard has already authenticated (the guard is
// global, but some controllers still carry their own @UseGuards(AuthGuard)).
const AUTHENTICATED = Symbol('authenticated');

@Injectable()
export class AuthGuard implements CanActivate {
  static readonly ADMIN_LEVEL = [RoleEnum.ADMIN];
  static readonly MANAGER_LEVEL = [...AuthGuard.ADMIN_LEVEL, RoleEnum.MANAGER];
  static readonly AGENT_LEVEL = [...AuthGuard.MANAGER_LEVEL, RoleEnum.AGENT];

  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
    private dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    // Detect if it's an http request or a webSocket message
    const isWebsocket = context.getType() === 'ws';
    const holder = isWebsocket
      ? context.switchToWs().getClient()
      : context.switchToHttp().getRequest();

    if (!holder[AUTHENTICATED]) {
      const token = isWebsocket
        ? AuthGuard.extractSocketToken(holder.handshake)
        : AuthGuard.extractBearerToken(holder.headers?.authorization);

      // 💡 We're assigning the user to the request object here
      // so that we can access it in our route handlers
      holder.user = await this.authenticate(token);
      holder[AUTHENTICATED] = true;
    }

    // Role based access control: handler level wins over controller level
    const roles = this.reflector.getAllAndOverride(Roles, targets);
    if (roles && !roles.includes(holder.user.role)) {
      throw new ForbiddenException();
    }

    return true;
  }

  /**
   * Verifies the JWT and loads the current state of its owner.
   * Throws 401 for a missing/invalid/expired token, a deleted account and
   * for ctr_agent (a customer contact record, never a login).
   */
  async authenticate(token: string | undefined): Promise<AuthUser> {
    if (!token) {
      throw new UnauthorizedException();
    }

    let payload: { sub?: number; exp?: number; tv?: number };
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException();
    }

    const id = Number(payload?.sub);
    if (!Number.isInteger(id)) {
      throw new UnauthorizedException();
    }

    const row = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('u')
      .select('u.id', 'id')
      .addSelect('u.username', 'username')
      .addSelect('u.role', 'role')
      .addSelect('u.permissions', 'permissions')
      .addSelect('u.group_id', 'group_id')
      .addSelect('u.token_version', 'token_version')
      .where('u.id = :id', { id })
      .andWhere('u.deleted_at IS NULL')
      .getRawOne();

    if (!row || !AuthGuard.AGENT_LEVEL.includes(row.role)) {
      throw new UnauthorizedException();
    }

    // signed out everywhere (password change, logout, rights change) after this token was issued
    if (Number(payload.tv ?? 0) !== Number(row.token_version ?? 0)) {
      throw new UnauthorizedException();
    }

    return {
      sub: row.id,
      username: row.username,
      role: row.role,
      permissions: row.permissions ?? null,
      group_id: row.group_id ?? null,
      exp: payload.exp,
    };
  }

  static extractBearerToken(header: unknown): string | undefined {
    if (typeof header !== 'string') {
      return undefined;
    }

    const [type, token] = header.trim().split(/\s+/);
    return type === 'Bearer' && token ? token : undefined;
  }

  /**
   * socket.io: the client sends `auth: { token }` (the frontend does), a
   * non-browser client may send the Authorization header instead. Both are
   * accepted with or without the "Bearer " prefix.
   */
  static extractSocketToken(handshake: any): string | undefined {
    const raw = handshake?.auth?.token ?? handshake?.headers?.authorization;
    if (typeof raw !== 'string' || !raw.trim()) {
      return undefined;
    }

    const parts = raw.trim().split(/\s+/);
    if (parts.length === 1) {
      return parts[0];
    }

    return parts[0] === 'Bearer' ? parts[1] : undefined;
  }
}
