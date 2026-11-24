import { Injectable, Logger } from '@nestjs/common';
import {
  DataSource,
  EntityMetadata,
  EntitySubscriberInterface,
  InsertEvent,
  QueryRunner,
  RecoverEvent,
  RemoveEvent,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { AuditContext } from './audit-context';
import { AuditJournal } from './audit-journal';
import { installManagerHooks } from './audit-hooks';
import { EntitySpec, specOfTable } from './audit-registry';

/** The many-to-many tables the journal follows: [the deal column, the other column]. */
const LINKS: Record<string, [string, string]> = {
  deal_user: ['dealId', 'userId'],
  deal_file: ['dealId', 'fileId'],
};

/**
 * Records what TypeORM saves (save / insert / remove / softRemove / recover) of the tracked tables
 * (audit-registry.ts): the state of the row is read before and after in the same transaction and the
 * difference waits in the query runner until right before COMMIT, when AuditJournal.flush writes it.
 * Query-builder updates and deletes come through audit-hooks.ts, raw SQL through AuditJournal.around.
 * Nothing here may break a save: a failure is logged.
 */
@Injectable()
export class AuditSubscriber implements EntitySubscriberInterface<any> {
  private readonly logger = new Logger('AuditJournal');

  constructor(dataSource: DataSource) {
    dataSource.subscribers.push(this);
    if (AuditJournal.enabled()) installManagerHooks();
  }

  // no listenTo(): every entity; the registry picks the tracked ones

  /**
   * A new history entry (table "event") carries where it came from: event.source / source_ref (TRG-5,
   * AUDIT-11), so that the history shows «триггер», «бот», «автопилот» on a message, a task or a letter the
   * automation made, not only on the changes of data. What the writer set stays.
   */
  beforeInsert(event: InsertEvent<any>): void {
    if (event.metadata?.tableName !== 'event') return;
    const entity = event.entity;
    const scope = AuditContext.current();
    if (!scope || !entity || typeof entity !== 'object' || entity.source) return;
    try {
      entity.source = scope.source;
      if (!entity.source_ref && scope.sourceRef) entity.source_ref = String(scope.sourceRef).slice(0, 64);
    } catch (error) {
      this.logger.warn(`journal (event source): ${(error as Error).message}`);
    }
  }

  async beforeUpdate(event: UpdateEvent<any>): Promise<void> {
    // a query-builder update has no row (and no databaseEntity): audit-hooks.ts
    const target = this.target(event.metadata, event.databaseEntity ?? null);
    if (target) await this.safely('read', () => AuditJournal.rememberBefore(event.queryRunner, target.spec, target.id));
  }

  async afterUpdate(event: UpdateEvent<any>): Promise<void> {
    const target = this.target(event.metadata, event.databaseEntity ?? null);
    if (target) await this.safely('update', () => this.changed(event.queryRunner, target.spec, target.id));
  }

  async afterInsert(event: InsertEvent<any>): Promise<void> {
    if (!AuditJournal.enabled()) return;
    const link = LINKS[event.metadata?.tableName];
    if (link) return this.link(event.queryRunner, event.metadata.tableName, event.entityId ?? event.entity, 'add');
    const spec = specOfTable(event.metadata?.tableName);
    // a new comment is the history entry itself: only its changes and its removal are journaled
    if (!spec || spec.key === 'comment') return;
    const id = this.idOf(event.metadata, event.entity) ?? this.idOf(event.metadata, event.entityId);
    if (id === null) return;
    await this.safely('insert', async () => {
      const [row] = await AuditJournal.readRows(event.queryRunner, spec, [id]);
      if (row) await AuditJournal.recordRows(event.queryRunner, spec, [{ before: null, after: row }]);
    });
  }

  async beforeRemove(event: RemoveEvent<any>): Promise<void> {
    const target = this.target(event.metadata, event.databaseEntity ?? event.entity ?? null, event.entityId);
    if (target) await this.safely('read', () => AuditJournal.rememberBefore(event.queryRunner, target.spec, target.id));
  }

  async afterRemove(event: RemoveEvent<any>): Promise<void> {
    if (!AuditJournal.enabled()) return;
    const link = LINKS[event.metadata?.tableName];
    if (link) return this.link(event.queryRunner, event.metadata.tableName, event.entityId, 'remove');
    const target = this.target(event.metadata, event.databaseEntity ?? event.entity ?? null, event.entityId);
    if (!target) return;
    await this.safely('delete', async () => {
      const before = AuditJournal.takeBefore(event.queryRunner, target.spec, target.id);
      if (before) await AuditJournal.recordRows(event.queryRunner, target.spec, [{ before, after: null }]);
    });
  }

  async beforeSoftRemove(event: SoftRemoveEvent<any>): Promise<void> {
    const target = this.target(event.metadata, event.databaseEntity ?? event.entity ?? null, event.entityId);
    if (target) await this.safely('read', () => AuditJournal.rememberBefore(event.queryRunner, target.spec, target.id));
  }

  async afterSoftRemove(event: SoftRemoveEvent<any>): Promise<void> {
    const target = this.target(event.metadata, event.databaseEntity ?? event.entity ?? null, event.entityId);
    if (target) await this.safely('soft delete', () => this.changed(event.queryRunner, target.spec, target.id));
  }

  async beforeRecover(event: RecoverEvent<any>): Promise<void> {
    const target = this.target(event.metadata, event.databaseEntity ?? event.entity ?? null, event.entityId);
    if (target) await this.safely('read', () => AuditJournal.rememberBefore(event.queryRunner, target.spec, target.id));
  }

  async afterRecover(event: RecoverEvent<any>): Promise<void> {
    const target = this.target(event.metadata, event.databaseEntity ?? event.entity ?? null, event.entityId);
    if (target) await this.safely('restore', () => this.changed(event.queryRunner, target.spec, target.id));
  }

  /** Right before COMMIT: the rows of the transaction go into audit_log (under a savepoint). */
  async beforeTransactionCommit(event: { queryRunner: QueryRunner }): Promise<void> {
    if (event?.queryRunner) await this.safely('flush', () => AuditJournal.flush(event.queryRunner));
  }

  beforeTransactionRollback(event: { queryRunner: QueryRunner }): void {
    if (event?.queryRunner) AuditJournal.rolledBack(event.queryRunner);
  }

  // ------------------------------------------------------------------ helpers

  private async changed(runner: QueryRunner, spec: EntitySpec, id: number): Promise<void> {
    const before = AuditJournal.takeBefore(runner, spec, id);
    if (before === undefined) return;
    const [after] = await AuditJournal.readRows(runner, spec, [id]);
    await AuditJournal.recordRows(runner, spec, [{ before, after: after ?? null }]);
  }

  /** The tracked row an entity event is about, or null (not tracked, not a single row, switched off). */
  private target(metadata: EntityMetadata, entity: any, entityId?: any): { spec: EntitySpec; id: number } | null {
    if (!AuditJournal.enabled() || !metadata) return null;
    const spec = specOfTable(metadata.tableName);
    if (!spec) return null;
    // only some rows of the table are journaled (comments among the history entries): no reads for the rest
    if (spec.accepts && entity && typeof entity === 'object' && 'type' in entity && !spec.accepts(entity)) return null;
    const id = this.idOf(metadata, entity) ?? this.idOf(metadata, entityId);
    return id === null ? null : { spec, id };
  }

  private idOf(metadata: EntityMetadata, entity: any): number | null {
    if (entity === null || entity === undefined) return null;
    if (typeof entity !== 'object') {
      const n = Number(entity);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    if (metadata.primaryColumns.length !== 1) return null;
    const n = Number(metadata.primaryColumns[0].getEntityValue(entity));
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  private link(runner: QueryRunner, table: string, id: any, op: 'add' | 'remove'): void {
    const [dealColumn, refColumn] = LINKS[table];
    const deal = Number(id?.[dealColumn]);
    const ref = Number(id?.[refColumn]);
    if (!Number.isInteger(deal) || !Number.isInteger(ref) || !runner) return;
    try {
      AuditJournal.noteLink(runner, table as 'deal_user' | 'deal_file', deal, ref, op);
    } catch (error) {
      this.logger.warn(`cannot note a change of ${table}: ${(error as Error).message}`);
    }
  }

  private async safely(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.warn(`journal (${what}): ${(error as Error).message}`);
    }
  }
}
