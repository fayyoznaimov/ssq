import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * Where a change comes from (audit_log.source):
 *  web        a person in the web client (an HTTP request with a login token)
 *  bot        the CRM bot in Telegram, acting for the linked user (commands, confirmed actions)
 *  trigger    a trigger of a stage (source_ref "trigger:<id>"), also when a person's action set it off
 *  autopilot  the rules that work by themselves: «следующий шаг», «клиент ждёт ответа»
 *  telegram   the receiver of the managers' Telegram (parisahon-telegram-service)
 *  whatsapp   the receiver of the managers' WhatsApp (parisahon-whatsapp-service)
 *  ftp        call recordings sent by the phones (parisahon-ftp → POST /calls/upload)
 *  ai         an AI step that writes by itself (card recognition and the like)
 *  mail       the mail sync (IMAP)
 *  system     start-up, migrations, anything without a known author
 */
export const AUDIT_SOURCES = ['web', 'bot', 'trigger', 'autopilot', 'telegram', 'whatsapp', 'ftp', 'ai', 'mail', 'system'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export interface AuditPerson {
  id: number | null;
  name: string | null;
}

/**
 * Who acts and from where, for everything the current request or job writes (AUDIT-16).
 * One scope = one operation = one save group (`batch`): the journal shows its rows together,
 * as one version of the objects (the version history of 1C, a change document of SAP).
 */
export interface AuditScope {
  /** the HTTP request (X-Request-Id, answered back) or the run of a job */
  requestId: string;
  /** the save group of this operation */
  batch: string;
  source: AuditSource;
  /** what acted besides a person: "trigger:42", "chat:…" */
  sourceRef: string | null;
  actorId: number | null;
  actorName: string | null;
  ip: string | null;
  userAgent: string | null;
  /** the person whose action set the automation off (a trigger run inside a manager's request) */
  causedBy: AuditPerson | null;
  /**
   * "deal:12:stage_id" → how many rows recorded it in this request / job (shared with the scopes opened
   * inside it). A snapshot check around automation (AuditJournal.around with `unrecordedOnly`) records
   * only what no other row recorded while it ran.
   */
  recorded: Map<string, number>;
}

const storage = new AsyncLocalStorage<AuditScope>();

/**
 * The request context of the journal on AsyncLocalStorage. HTTP requests get it from
 * AuditContextMiddleware (request id, address, source by route) and AuditContextInterceptor (the
 * user, after the AuthGuard); jobs, the bot and the triggers open their own with run() / automation().
 * The journal (AuditJournal, the TypeORM subscriber) takes the author from here: a service does not
 * have to pass the user through every layer, and a new path cannot forget it.
 */
export class AuditContext {
  static current(): AuditScope | undefined {
    return storage.getStore();
  }

  /**
   * Runs `fn` in a new scope: a new save group; the request id, the address and the source come from
   * the enclosing scope unless given, the author does not (an automation is not the person).
   */
  static run<T>(patch: Partial<AuditScope>, fn: () => T): T {
    const parent = storage.getStore();
    const scope: AuditScope = {
      requestId: patch.requestId ?? parent?.requestId ?? randomUUID(),
      batch: patch.batch ?? randomUUID(),
      source: patch.source ?? parent?.source ?? 'system',
      sourceRef: patch.sourceRef !== undefined ? patch.sourceRef : null,
      actorId: patch.actorId !== undefined ? patch.actorId : null,
      actorName: patch.actorName !== undefined ? patch.actorName : null,
      ip: patch.ip !== undefined ? patch.ip : parent?.ip ?? null,
      userAgent: patch.userAgent !== undefined ? patch.userAgent : parent?.userAgent ?? null,
      causedBy: patch.causedBy !== undefined ? patch.causedBy : null,
      recorded: parent?.recorded ?? new Map<string, number>(),
    };
    return storage.run(scope, fn);
  }

  /**
   * An automation step (a trigger run, a tick of the autopilot): its own save group and source, no
   * person as the author; the person of the enclosing scope (if any) is kept as the one who set it off.
   */
  static automation<T>(source: AuditSource, sourceRef: string | null, fn: () => T): T {
    const parent = storage.getStore();
    const person = parent && (parent.actorId || parent.actorName) ? { id: parent.actorId, name: parent.actorName } : null;
    return AuditContext.run({ source, sourceRef, causedBy: person ?? parent?.causedBy ?? null }, fn);
  }

  /** The person of the current scope, once known (the interceptor after the AuthGuard, the bot after the chat). */
  static setActor(id: number | null, name: string | null): void {
    const scope = storage.getStore();
    if (!scope) return;
    scope.actorId = id ?? null;
    scope.actorName = name ?? null;
  }

  /** The source of the current scope (a route the middleware could not tell by its address). */
  static setSource(source: AuditSource, sourceRef: string | null = null): void {
    const scope = storage.getStore();
    if (!scope) return;
    scope.source = source;
    if (sourceRef !== null) scope.sourceRef = sourceRef;
  }
}
