import { Logger } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { AuditContext, AuditSource } from './audit-context';
import { EntitySpec, isQuiet, isSecret, specOfEntity, specOfTable } from './audit-registry';

/**
 * The writer of the journal «кто что изменил» (audit_log).
 *
 *  - A row is written in the transaction of the change: inside a transaction the rows wait in the
 *    query runner and go to the database in one INSERT right before COMMIT (AuditSubscriber), so a
 *    rolled back change leaves no row and a committed one has its row. Outside a transaction the row
 *    is written at once.
 *  - It never breaks the change: the INSERT runs under a savepoint, a failure is logged, the change
 *    commits anyway. Reading the states adds a primary-key SELECT per row (the CRM writes a few rows
 *    per request).
 *  - Secrets (passwords, hashes, tokens, signatures, the names of files on the disk) are never stored:
 *    only «изменён». Long texts are shortened, binary values dropped.
 * AUDIT_LOG=0 switches the journal off (nothing is recorded; the change works as before).
 */

export type AuditAction =
  | 'insert'
  | 'update'
  | 'delete'
  | 'soft_delete'
  | 'restore'
  | 'permissions'
  | 'settings'
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'baseline';

export const AUDIT_ACTIONS: AuditAction[] = [
  'insert',
  'update',
  'delete',
  'soft_delete',
  'restore',
  'permissions',
  'settings',
  'login',
  'logout',
  'login_failed',
  'baseline',
];

export interface AuditEntry {
  entity: string;
  entityId?: number | string | null;
  action: AuditAction;
  changes?: Record<string, [unknown, unknown]> | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  summary?: string | null;
  dealId?: number | null;
  companyId?: number | null;
  contactId?: number | null;
  meta?: Record<string, unknown> | null;
  /** filled from AuditContext when not given */
  actorId?: number | null;
  actorName?: string | null;
  source?: string;
  sourceRef?: string | null;
  batch?: string;
  requestId?: string | null;
  at?: Date;
}

/** What the database gets: one object per row of audit_log. */
interface AuditRecord {
  at: string;
  batch: string;
  request_id: string | null;
  actor_id: number | null;
  actor_name: string | null;
  source: string;
  source_ref: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  changes: Record<string, unknown> | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  summary: string | null;
  deal_id: number | null;
  company_id: number | null;
  contact_id: number | null;
  meta: Record<string, unknown> | null;
}

/** A link of a many-to-many table changed (a contact added to a deal, a file attached to it). */
interface PendingLink {
  table: 'deal_user' | 'deal_file';
  deal: number;
  ref: number;
  op: 'add' | 'remove';
  depth: number;
  record: AuditRecord;
}

interface Pending {
  records: { record: AuditRecord; depth: number }[];
  links: PendingLink[];
  before: Map<string, Record<string, any> | null>;
}

const PENDING = '__parisaAudit';
const LONG_TEXT = 300;
const MAX_TEXT = 2000;
const MAX_ROWS = 2000;
const SECRET_MARK = '***';

export const ACTION_TEXT: Record<string, string> = {
  insert: 'Создание',
  update: 'Изменение',
  delete: 'Удаление',
  soft_delete: 'Удаление в корзину',
  restore: 'Восстановление',
  permissions: 'Изменение прав',
  settings: 'Изменение настроек',
  login: 'Вход в CRM',
  logout: 'Выход из CRM',
  login_failed: 'Неудачная попытка входа',
  baseline: 'Состояние на момент включения журнала',
};

type Db = DataSource | EntityManager | QueryRunner;

const logger = new Logger('AuditJournal');

/** An integer id or null. */
function intOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
}

/** A value as JSON keeps it: dates as ISO text, no binary, no NUL (jsonb refuses \u0000). */
export function plainValue(value: any): any {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return null;
  if (typeof value === 'string') {
    const text = value.indexOf('\u0000') >= 0 ? value.replace(/\u0000/g, '') : value;
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(plainValue);
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value)) out[key] = plainValue(value[key]);
    return out;
  }
  return String(value);
}

/** The same value? Objects by their content, whatever the order of their keys. */
export function sameValue(a: any, b: any): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  // "12" and 12 (numeric columns come as text, a number from JS): the same value
  return JSON.stringify(typeof value === 'number' ? String(value) : value);
}

function shorten(spec: EntitySpec | undefined, column: string, value: any): any {
  if (typeof value === 'string' && spec?.long?.includes(column) && value.length > LONG_TEXT) {
    return `${value.slice(0, LONG_TEXT)}…`;
  }
  return value;
}

export class AuditJournal {
  static enabled(): boolean {
    return process.env.AUDIT_LOG !== '0';
  }

  // ------------------------------------------------------------------ states and differences

  /** The row as the journal keeps it: its own columns, no secrets, long texts shortened. */
  static stateOf(spec: EntitySpec, row: Record<string, any> | null): Record<string, any> | null {
    if (!row) return null;
    const source = spec.project ? spec.project(row) : row;
    const out: Record<string, any> = {};
    for (const key of Object.keys(source)) {
      if (isSecret(spec, key)) continue;
      out[key] = shorten(spec, key, plainValue(source[key]));
    }
    return out;
  }

  /** {column: [old, new]} of what changed, quiet columns left out, secrets as «***». */
  static diff(spec: EntitySpec, beforeRow: Record<string, any>, afterRow: Record<string, any>): Record<string, [unknown, unknown]> {
    const before = spec.project ? spec.project(beforeRow) : beforeRow;
    const after = spec.project ? spec.project(afterRow) : afterRow;
    const out: Record<string, [unknown, unknown]> = {};
    for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      if (key === spec.pk || isQuiet(spec, key)) continue;
      const was = plainValue(before?.[key]);
      const now = plainValue(after?.[key]);
      if (sameValue(was, now)) continue;
      out[key] = isSecret(spec, key)
        ? [was === null ? null : SECRET_MARK, now === null ? null : SECRET_MARK]
        : [shorten(spec, key, was), shorten(spec, key, now)];
    }
    return out;
  }

  /** All shown values of a new (or removed) object: {column: [null, value]} or {column: [value, null]}. */
  private static fullChanges(spec: EntitySpec, row: Record<string, any>, removed: boolean): Record<string, [unknown, unknown]> {
    const source = spec.project ? spec.project(row) : row;
    const out: Record<string, [unknown, unknown]> = {};
    for (const key of Object.keys(source)) {
      if (key === spec.pk || isQuiet(spec, key) || key === spec.softDelete) continue;
      let value = plainValue(source[key]);
      if (value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
      value = isSecret(spec, key) ? SECRET_MARK : shorten(spec, key, value);
      out[key] = removed ? [value, null] : [null, value];
    }
    return out;
  }

  /**
   * The journal entry of one row: inserted (no before), deleted (no after) or changed; null when
   * nothing worth a row changed (only service columns) or the table keeps only some rows (comments).
   */
  static entryOf(spec: EntitySpec, beforeRow: Record<string, any> | null, afterRow: Record<string, any> | null): AuditEntry | null {
    const row = afterRow ?? beforeRow;
    if (!row) return null;
    if (spec.accepts && !spec.accepts(row)) return null;
    const entity = spec.entityOf ? spec.entityOf(row) : spec.key;
    let action: AuditAction;
    let changes: Record<string, [unknown, unknown]>;
    if (beforeRow && afterRow) {
      changes = AuditJournal.diff(spec, beforeRow, afterRow);
      if (!Object.keys(changes).length) return null;
      action = AuditJournal.actionOf(spec, entity, changes);
    } else if (afterRow) {
      action = 'insert';
      changes = AuditJournal.fullChanges(spec, afterRow, false);
    } else {
      action = 'delete';
      changes = AuditJournal.fullChanges(spec, beforeRow, true);
    }
    const projected = spec.project ? spec.project(row) : row;
    const links = spec.links(projected);
    const before = AuditJournal.stateOf(spec, beforeRow);
    const after = AuditJournal.stateOf(spec, afterRow);
    return {
      entity,
      entityId: row[spec.pk] ?? null,
      action,
      changes,
      before,
      after,
      summary: AuditJournal.summaryOf(spec, entity, action, after ?? before, changes),
      dealId: links.deal ?? null,
      companyId: links.company ?? null,
      contactId: links.contact ?? null,
    };
  }

  /** A change of the soft delete column is «в корзину» / «восстановлено»; rights and settings have their own kind. */
  static actionOf(spec: EntitySpec, entity: string, changes: Record<string, [unknown, unknown]>): AuditAction {
    if (spec.softDelete && changes[spec.softDelete]) {
      const [was, now] = changes[spec.softDelete];
      if (!was && now) return 'soft_delete';
      if (was && !now) return 'restore';
    }
    if (entity === 'user' && ['role', 'permissions', 'group_id'].some((key) => key in changes)) return 'permissions';
    if (entity === 'setting') return 'settings';
    return 'update';
  }

  static summaryOf(
    spec: EntitySpec,
    entity: string,
    action: AuditAction,
    state: Record<string, any> | null,
    changes: Record<string, [unknown, unknown]> | null,
  ): string {
    const title = spec.title(state ?? {}, entity);
    const head = `${ACTION_TEXT[action] ?? action}: ${title}`;
    if (!['update', 'permissions', 'settings', 'restore', 'soft_delete'].includes(action) || !changes) return head;
    const labels = Object.keys(changes)
      .filter((key) => key !== spec.softDelete)
      .map((key) => spec.fields[key]?.label ?? key);
    return labels.length ? `${head} — ${[...new Set(labels)].join(', ')}` : head;
  }

  // ------------------------------------------------------------------ reading rows

  /** The states of rows by their primary key, in the transaction of `db`. */
  static async readRows(db: Db, spec: EntitySpec, ids: unknown[]): Promise<Record<string, any>[]> {
    // every tracked table has an integer key
    const keys = [...new Set(ids.map((id) => intOrNull(id)).filter((id): id is number => id !== null))];
    if (!keys.length) return [];
    return AuditJournal.readWhere(db, spec, `t."${spec.pk}" = ANY($1::int[])`, [keys]);
  }

  /** The states of the rows a condition picks (`t` is the table). */
  static async readWhere(db: Db, spec: EntitySpec, where: string, params: unknown[]): Promise<Record<string, any>[]> {
    const condition = spec.scope ? `(${where}) AND ${spec.scope}` : where;
    const sql = `SELECT t.*${spec.extra ? `, ${spec.extra}` : ''} FROM "${spec.table}" t WHERE ${condition} LIMIT ${MAX_ROWS}`;
    const rows = await AuditJournal.safeQuery(db, sql, params);
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * A read of the journal inside the transaction of a change runs under a savepoint: a failed read
   * must not leave the transaction aborted (the change would fail with it). It throws; callers log.
   */
  static async safeQuery(db: Db, sql: string, params: unknown[]): Promise<any> {
    const runner = AuditJournal.transactionOf(db);
    if (!runner) return db.query(sql, params);
    await runner.query('SAVEPOINT parisa_audit_read');
    try {
      const rows = await runner.query(sql, params);
      await runner.query('RELEASE SAVEPOINT parisa_audit_read');
      return rows;
    } catch (error) {
      await runner.query('ROLLBACK TO SAVEPOINT parisa_audit_read').catch(() => undefined);
      await runner.query('RELEASE SAVEPOINT parisa_audit_read').catch(() => undefined);
      throw error;
    }
  }

  // ------------------------------------------------------------------ recording

  /** The rows of a context: who, from where, which operation. */
  private static stamp(entry: AuditEntry): AuditRecord {
    const scope = AuditContext.current();
    const meta: Record<string, unknown> = { ...(entry.meta ?? {}) };
    if (scope?.causedBy && (scope.causedBy.id || scope.causedBy.name) && meta.caused_by === undefined) {
      meta.caused_by = { id: scope.causedBy.id, name: scope.causedBy.name };
    }
    const entityId = entry.entityId === null || entry.entityId === undefined ? null : String(entry.entityId);
    if (scope && entityId && entry.changes) {
      for (const key of Object.keys(entry.changes)) {
        const name = `${entry.entity}:${entityId}:${key}`;
        scope.recorded.set(name, (scope.recorded.get(name) ?? 0) + 1);
      }
    }
    return {
      at: (entry.at ?? new Date()).toISOString(),
      batch: entry.batch ?? scope?.batch ?? '00000000-0000-0000-0000-000000000000',
      request_id: entry.requestId !== undefined ? entry.requestId : scope?.requestId ?? null,
      actor_id: entry.actorId !== undefined ? entry.actorId : scope?.actorId ?? null,
      actor_name: (entry.actorName !== undefined ? entry.actorName : scope?.actorName ?? null)?.slice(0, 255) ?? null,
      source: entry.source ?? scope?.source ?? 'system',
      source_ref: (entry.sourceRef !== undefined ? entry.sourceRef : scope?.sourceRef ?? null)?.slice(0, 64) ?? null,
      entity: entry.entity.slice(0, 32),
      entity_id: entityId && /^-?\d{1,18}$/.test(entityId) ? entityId : null,
      action: entry.action,
      changes: plainValue(entry.changes ?? null),
      before_state: plainValue(entry.before ?? null),
      after_state: plainValue(entry.after ?? null),
      summary: entry.summary ? String(entry.summary).replace(/\u0000/g, '').slice(0, MAX_TEXT) : null,
      deal_id: intOrNull(entry.dealId),
      company_id: intOrNull(entry.companyId),
      contact_id: intOrNull(entry.contactId),
      meta: Object.keys(meta).length ? plainValue(meta) : null,
    };
  }

  /**
   * Explicit rows (a change made with raw SQL, a login): in the transaction of `db` when it has
   * one, at once otherwise. Never throws.
   */
  static async record(db: Db, entries: AuditEntry | AuditEntry[] | null | undefined): Promise<void> {
    if (!AuditJournal.enabled()) return;
    const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean) as AuditEntry[];
    if (!list.length) return;
    try {
      const records = list.map((entry) => AuditJournal.stamp(entry));
      const runner = AuditJournal.transactionOf(db);
      if (runner) {
        const pending = AuditJournal.pending(runner);
        const depth = AuditJournal.depthOf(runner);
        for (const record of records) pending.records.push({ record, depth });
        return;
      }
      await AuditJournal.write(db, records);
    } catch (error) {
      logger.warn(`cannot record ${list[0]?.entity}/${list[0]?.action}: ${(error as Error).message}`);
    }
  }

  /** Rows of journal entries made from database rows (the subscriber, around()). */
  static async recordRows(
    db: Db,
    spec: EntitySpec,
    pairs: { before: Record<string, any> | null; after: Record<string, any> | null }[],
    meta?: Record<string, unknown>,
    /** attributes recorded by other rows meanwhile ("deal:12:stage_id"): left out */
    recordedElsewhere?: (key: string) => boolean,
  ): Promise<void> {
    const entries: AuditEntry[] = [];
    for (const pair of pairs) {
      const entry = AuditJournal.entryOf(spec, pair.before, pair.after);
      if (!entry) continue;
      if (recordedElsewhere && entry.changes && entry.entityId !== null && entry.entityId !== undefined) {
        for (const key of Object.keys(entry.changes)) {
          if (recordedElsewhere(`${entry.entity}:${entry.entityId}:${key}`)) delete entry.changes[key];
        }
        if (!Object.keys(entry.changes).length) continue;
        if (entry.action !== 'insert' && entry.action !== 'delete') entry.action = AuditJournal.actionOf(spec, entry.entity, entry.changes);
        entry.summary = AuditJournal.summaryOf(spec, entry.entity, entry.action, entry.after ?? entry.before, entry.changes);
      }
      entries.push(meta ? { ...entry, meta: { ...(entry.meta ?? {}), ...meta } } : entry);
    }
    await AuditJournal.record(db, entries);
  }

  /**
   * Raw SQL and query-builder changes: the rows `where` picks are read before `change` runs and again
   * after it, and what changed is recorded (`t` is the table in `where`). Inside the transaction of
   * `db` when it has one. A failure of the journal never stops `change`.
   *
   *   await AuditJournal.around(manager, 'deal', 't.id = $1', [id], () => manager.query(`UPDATE deal …`));
   */
  static async around<T>(
    db: Db,
    entity: string | EntitySpec,
    where: string,
    params: unknown[],
    change: () => Promise<T>,
    meta?: Record<string, unknown>,
    options: { unrecordedOnly?: boolean } = {},
  ): Promise<T> {
    const spec = typeof entity === 'string' ? specOfEntity(entity) ?? specOfTable(entity) : entity;
    if (!spec || !AuditJournal.enabled()) return change();
    let before: Record<string, any>[] | null = null;
    try {
      before = await AuditJournal.readWhere(db, spec, where, params);
    } catch (error) {
      logger.warn(`cannot read ${spec.table} before a change: ${(error as Error).message}`);
    }
    // what the rows of the subscriber record while `change` runs (unrecordedOnly: those are not repeated)
    const recorded = options.unrecordedOnly ? AuditContext.current()?.recorded : undefined;
    const counted = recorded ? new Map(recorded) : null;
    const result = await change();
    if (before?.length) {
      try {
        const after = await AuditJournal.readRows(db, spec, before.map((row) => row[spec.pk]));
        const byId = new Map(after.map((row) => [String(row[spec.pk]), row]));
        await AuditJournal.recordRows(
          db,
          spec,
          before.map((row) => ({ before: row, after: byId.get(String(row[spec.pk])) ?? null })),
          meta,
          recorded ? (key) => (recorded.get(key) ?? 0) > (counted.get(key) ?? 0) : undefined,
        );
      } catch (error) {
        logger.warn(`cannot record a change of ${spec.table}: ${(error as Error).message}`);
      }
    }
    return result;
  }

  /**
   * A run of a trigger (TriggerService.executeTrigger): its own operation with the source "trigger"
   * and the trigger's id, no person as the author (the person whose action set it off is kept), and a
   * check of the deal before and after it, so that an action that changes the deal by raw SQL (a move
   * to another stage) is in the journal too; what the subscriber recorded meanwhile is not repeated.
   */
  static trigger<T>(db: DataSource, triggerId: number, dealId: number, run: () => Promise<T>): Promise<T> {
    return AuditContext.automation('trigger', `trigger:${triggerId}`, () =>
      AuditJournal.around(db, 'deal', 't.id = $1', [dealId], run, undefined, { unrecordedOnly: true }),
    );
  }

  /**
   * A tick of a job that changes data by itself (the autopilot, «клиент ждёт ответа», the queue of call
   * recordings, the mail sync, the AI queue): its own operation, the job as the author.
   */
  static job<T>(source: AuditSource, name: string, run: () => Promise<T>): Promise<T> {
    return AuditContext.run({ source, sourceRef: name }, run);
  }

  /**
   * A file put on / taken off a deal outside a save (RelationQueryBuilder, raw SQL): «Файл прикреплён к
   * сделке» / «Файл убран из сделки» with its name and size (CALL-12; the trigger «удалить файлы» too).
   */
  static async fileLink(
    db: Db,
    op: 'add' | 'remove',
    dealId: number,
    file: { id: number; name?: string | null; from?: string | null; size?: unknown },
  ): Promise<void> {
    if (!file?.id) return;
    const state = { file_id: file.id, deal_id: dealId, name: file.name ?? null, from: file.from ?? null, size: file.size ?? null };
    await AuditJournal.record(db, {
      entity: 'file_link',
      entityId: file.id,
      action: op === 'add' ? 'insert' : 'delete',
      changes: op === 'add' ? { file_id: [null, file.id] } : { file_id: [file.id, null] },
      before: op === 'remove' ? state : null,
      after: op === 'add' ? state : null,
      summary: `${op === 'add' ? 'Файл прикреплён к сделке' : 'Файл убран из сделки'}${file.name ? `: «${file.name}»` : ''}`,
      dealId,
    });
  }

  /** Rows inserted by raw SQL with RETURNING id: recorded as new objects. */
  static async inserted(db: Db, entity: string, ids: unknown[], meta?: Record<string, unknown>): Promise<void> {
    const spec = specOfEntity(entity) ?? specOfTable(entity);
    if (!spec || !AuditJournal.enabled() || !ids.length) return;
    try {
      const rows = await AuditJournal.readRows(db, spec, ids);
      await AuditJournal.recordRows(db, spec, rows.map((row) => ({ before: null, after: row })), meta);
    } catch (error) {
      logger.warn(`cannot record new rows of ${spec.table}: ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ the subscriber's side

  /** The query runner of an open transaction of `db`, if it has one. */
  static transactionOf(db: Db): QueryRunner | null {
    const runner: QueryRunner | undefined =
      db instanceof DataSource ? undefined : db instanceof EntityManager ? db.queryRunner : (db as QueryRunner);
    return runner && runner.isTransactionActive && !runner.isReleased ? runner : null;
  }

  private static depthOf(runner: QueryRunner): number {
    return Number((runner as any).transactionDepth ?? 1) || 1;
  }

  private static pending(runner: QueryRunner): Pending {
    const data = (runner.data ??= {}) as Record<string, any>;
    if (!data[PENDING]) data[PENDING] = { records: [], links: [], before: new Map() } as Pending;
    return data[PENDING] as Pending;
  }

  /** Before a save changes or removes a row: its state now (consumed by the "after" event). */
  static async rememberBefore(runner: QueryRunner, spec: EntitySpec, id: unknown): Promise<void> {
    const [row] = await AuditJournal.readRows(runner, spec, [id]);
    AuditJournal.pending(runner).before.set(`${spec.table}:${String(id)}`, row ?? null);
  }

  static takeBefore(runner: QueryRunner, spec: EntitySpec, id: unknown): Record<string, any> | null | undefined {
    const pending = AuditJournal.pending(runner);
    const key = `${spec.table}:${String(id)}`;
    const row = pending.before.get(key);
    pending.before.delete(key);
    return row;
  }

  /** A contact added to / taken off a deal, a file attached / detached (the many-to-many tables). */
  static noteLink(runner: QueryRunner, table: 'deal_user' | 'deal_file', deal: number, ref: number, op: 'add' | 'remove'): void {
    if (!AuditJournal.transactionOf(runner)) return;
    AuditJournal.pending(runner).links.push({
      table,
      deal,
      ref,
      op,
      depth: AuditJournal.depthOf(runner),
      // stamped now: the author of the moment of the change
      record: AuditJournal.stamp({ entity: table === 'deal_user' ? 'deal' : 'file_link', action: 'update' }),
    });
  }

  /** A savepoint committed: its rows belong to the enclosing level now. */
  static committedLevel(runner: QueryRunner): void {
    const data = runner.data as Record<string, any> | undefined;
    const pending = data?.[PENDING] as Pending | undefined;
    if (!pending) return;
    const depth = AuditJournal.depthOf(runner);
    for (const item of pending.records) if (item.depth >= depth) item.depth = depth - 1;
    for (const link of pending.links) if (link.depth >= depth) link.depth = depth - 1;
  }

  /** A rollback: the rows of this level (or of the whole transaction) are dropped. */
  static rolledBack(runner: QueryRunner): void {
    const data = runner.data as Record<string, any> | undefined;
    const pending = data?.[PENDING] as Pending | undefined;
    if (!pending) return;
    const depth = AuditJournal.depthOf(runner);
    if (depth <= 1) {
      delete data[PENDING];
      return;
    }
    pending.records = pending.records.filter((item) => item.depth < depth);
    pending.links = pending.links.filter((link) => link.depth < depth);
  }

  /** Right before COMMIT of the outermost level: the waiting rows go into audit_log. */
  static async flush(runner: QueryRunner): Promise<void> {
    const data = runner.data as Record<string, any> | undefined;
    const pending = data?.[PENDING] as Pending | undefined;
    if (!pending) return;
    if (AuditJournal.depthOf(runner) > 1) {
      AuditJournal.committedLevel(runner);
      return;
    }
    delete data[PENDING];
    try {
      const records = pending.records.map((item) => item.record);
      if (pending.links.length) records.push(...(await AuditJournal.linkRecords(runner, pending.links, records)));
      if (records.length) await AuditJournal.write(runner, records);
    } catch (error) {
      logger.warn(`cannot write the journal of a transaction: ${(error as Error).message}`);
    }
  }

  /**
   * The rows of the link changes: a deal's contacts as a change of the deal («Контакты: А → А, Б»),
   * unless the deal's own row of this transaction already has them; a file attached to / detached
   * from a deal («Файл в сделке»). Files of messages and letters are a part of the message: their
   * attaching is not a row of its own (their detaching is).
   */
  private static async linkRecords(runner: QueryRunner, links: PendingLink[], records: AuditRecord[]): Promise<AuditRecord[]> {
    const out: AuditRecord[] = [];
    const dealSpec = specOfTable('deal');
    const dealsWithRow = new Set(records.filter((r) => r.entity === 'deal' && r.entity_id).map((r) => Number(r.entity_id)));

    const contactLinks = links.filter((link) => link.table === 'deal_user' && !dealsWithRow.has(link.deal));
    const deals = [...new Set(contactLinks.map((link) => link.deal))];
    if (deals.length && dealSpec) {
      const rows = await AuditJournal.readRows(runner, dealSpec, deals);
      for (const row of rows) {
        const id = Number(row.id);
        const now = ((row.contacts ?? []) as unknown[]).map(Number);
        const mine = contactLinks.filter((link) => link.deal === id);
        const was = new Set(now);
        for (const link of mine) {
          if (link.op === 'add') was.delete(link.ref);
          else was.add(link.ref);
        }
        const before = [...was].sort((a, b) => a - b);
        if (sameValue(before, now)) continue;
        const entry = AuditJournal.entryOf(dealSpec, { ...row, contacts: before }, row);
        if (!entry) continue;
        const stamped = AuditJournal.stamp(entry);
        // the author and the operation of the moment of the link change
        out.push({ ...stamped, ...AuditJournal.who(mine[0].record) });
      }
    }

    const fileLinks = links.filter((link) => link.table === 'deal_file');
    if (fileLinks.length) {
      const fileIds = [...new Set(fileLinks.map((link) => link.ref))];
      const files: { id: number; name: string; from: string; size: string }[] = await AuditJournal.safeQuery(
        runner,
        `SELECT id, name, "from", size FROM file WHERE id = ANY($1::int[])`,
        [fileIds],
      );
      const byId = new Map(files.map((file) => [Number(file.id), file]));
      const insertedFiles = new Set(records.filter((r) => r.entity === 'file' && r.action === 'insert').map((r) => Number(r.entity_id)));
      const deletedFiles = new Map(
        records.filter((r) => r.entity === 'file' && r.action === 'delete').map((r) => [Number(r.entity_id), r.before_state]),
      );
      for (const link of fileLinks) {
        const file: any = byId.get(link.ref) ?? deletedFiles.get(link.ref) ?? null;
        if (link.op === 'add') {
          if (insertedFiles.has(link.ref)) continue;
          if (file && ['from_messages', 'from_emails'].includes(String(file.from))) continue;
        }
        const state = { file_id: link.ref, deal_id: link.deal, name: file?.name ?? null, from: file?.from ?? null, size: file?.size ?? null };
        out.push({
          ...link.record,
          entity: 'file_link',
          entity_id: String(link.ref),
          action: link.op === 'add' ? 'insert' : 'delete',
          changes: link.op === 'add' ? { file_id: [null, link.ref] } : { file_id: [link.ref, null] },
          before_state: link.op === 'remove' ? plainValue(state) : null,
          after_state: link.op === 'add' ? plainValue(state) : null,
          summary: `${link.op === 'add' ? 'Файл прикреплён к сделке' : 'Файл убран из сделки'}${file?.name ? `: «${file.name}»` : ''}`,
          deal_id: link.deal,
          company_id: null,
          contact_id: null,
        });
      }
    }
    return out;
  }

  private static who(record: AuditRecord): Partial<AuditRecord> {
    return {
      at: record.at,
      batch: record.batch,
      request_id: record.request_id,
      actor_id: record.actor_id,
      actor_name: record.actor_name,
      source: record.source,
      source_ref: record.source_ref,
      meta: record.meta,
    };
  }

  /** One INSERT for all the rows; under a savepoint inside a transaction (a failure leaves the change alone). */
  private static async write(db: Db, records: AuditRecord[]): Promise<void> {
    if (!records.length) return;
    const sql = `INSERT INTO audit_log (at, batch, request_id, actor_id, actor_name, source, source_ref, entity, entity_id,
                   action, changes, before_state, after_state, summary, deal_id, company_id, contact_id, meta)
                 SELECT at, batch, request_id, actor_id, actor_name, source, source_ref, entity, entity_id,
                        action, changes, before_state, after_state, summary, deal_id, company_id, contact_id, meta
                   FROM jsonb_to_recordset($1::jsonb) AS x(at timestamptz, batch varchar, request_id varchar,
                        actor_id int, actor_name varchar, source varchar, source_ref varchar, entity varchar,
                        entity_id bigint, action varchar, changes jsonb, before_state jsonb, after_state jsonb,
                        summary text, deal_id int, company_id int, contact_id int, meta jsonb)`;
    const payload = JSON.stringify(records);
    const runner = AuditJournal.transactionOf(db);
    if (!runner) {
      try {
        await db.query(sql, [payload]);
      } catch (error) {
        logger.warn(`cannot write ${records.length} journal row(s): ${(error as Error).message}`);
      }
      return;
    }
    await runner.query('SAVEPOINT parisa_audit');
    try {
      await runner.query(sql, [payload]);
      await runner.query('RELEASE SAVEPOINT parisa_audit');
    } catch (error) {
      logger.warn(`cannot write ${records.length} journal row(s): ${(error as Error).message}`);
      await runner.query('ROLLBACK TO SAVEPOINT parisa_audit').catch(() => undefined);
      await runner.query('RELEASE SAVEPOINT parisa_audit').catch(() => undefined);
    }
  }
}
