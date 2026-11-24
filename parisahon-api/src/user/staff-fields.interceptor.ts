import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { AuthGuard, AuthUser } from '../auth/auth.guard';
import { RoleEnum } from './user.entity';

/** What a colleague's account must not show to an agent: rights, goals and messenger ids. */
const PRIVATE_STAFF_FIELDS = ['permissions', 'objectives', 'tg_id', 'wa_id', 'tg_api_id', 'tg_api_hash', 'sign', 'token_version'];
const STAFF_ROLES = new Set<string>([RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT]);

/**
 * Every answer of the API: an agent sees other staff accounts with the public fields only (id, name,
 * e-mail, phone, role, group, photo, dates), wherever they are — the responsible of a deal, the author
 * of a task or an event, a member of a group. /users hid them (hideStaffDetails), but a deal or a task
 * carried the rights, Telegram id and goals of the colleague in full. Admin and manager see everything;
 * one's own account and the customer contacts are untouched.
 */
@Injectable()
export class StaffFieldsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const requester: AuthUser | undefined = context.switchToHttp().getRequest()?.user;
    if (!requester || AuthGuard.MANAGER_LEVEL.includes(requester.role)) return next.handle();
    return next.handle().pipe(map((body) => strip(body, requester.sub)));
  }
}

function strip(body: unknown, selfId: number): unknown {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (value instanceof Date || value instanceof StreamableFile || Buffer.isBuffer(value)) return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.role === 'string' && STAFF_ROLES.has(record.role) && 'username' in record && record.id !== selfId) {
      for (const field of PRIVATE_STAFF_FIELDS) delete record[field];
    }
    for (const key of Object.keys(record)) walk(record[key], depth + 1);
  };
  walk(body, 0);
  return body;
}
