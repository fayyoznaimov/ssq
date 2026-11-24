import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { AuditContext, AuditSource } from './audit-context';
import { LoginThrottle } from '../auth/login-throttle';

/**
 * Routes that are not a person in the browser: the receivers of the services (their own token,
 * @Public) and the MCP endpoint of the CRM bot. Everything else is "web"; the user comes after the
 * AuthGuard (AuditContextInterceptor).
 */
const ROUTE_SOURCES: [RegExp, AuditSource, string | null][] = [
  [/^\/api\/v1\/telegram\/incoming(\/|\?|$)/, 'telegram', 'parisahon-telegram-service'],
  [/^\/api\/v1\/whatsapp\/incoming(\/|\?|$)/, 'whatsapp', 'parisahon-whatsapp-service'],
  [/^\/api\/v1\/calls\/upload(\/|\?|$)/, 'ftp', 'parisahon-ftp'],
  [/^\/api\/v1\/bot\/mcp(\/|\?|$)/, 'bot', 'claude'],
];

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/**
 * Opens the journal context of every HTTP request (AUDIT-16): the request id (X-Request-Id from
 * nginx or a new one, answered back in the same header), the address and browser, the source by
 * the route. Everything the request writes, through any service, carries it (AuditJournal).
 */
@Injectable()
export class AuditContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const header = request.headers['x-request-id'];
    const given = typeof header === 'string' && REQUEST_ID.test(header) ? header : null;
    const requestId = given ?? randomUUID();
    if (!response.headersSent) response.setHeader('X-Request-Id', requestId);
    const path = request.originalUrl ?? request.url ?? '';
    const route = ROUTE_SOURCES.find(([pattern]) => pattern.test(path));
    const agent = request.headers['user-agent'];
    AuditContext.run(
      {
        requestId,
        source: route ? route[1] : 'web',
        sourceRef: route ? route[2] : null,
        ip: LoginThrottle.clientAddress(request),
        userAgent: typeof agent === 'string' ? agent.slice(0, 255) : null,
      },
      () => next(),
    );
  }
}
