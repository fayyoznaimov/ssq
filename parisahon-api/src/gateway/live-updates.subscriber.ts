import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  RemoveEvent,
  SoftRemoveEvent,
  RecoverEvent,
  UpdateEvent,
} from 'typeorm';
import { NotificationGateWay } from './notification.gateway';

/**
 * Live updates: pages refresh themselves without the "Обновить" button.
 *
 * Every insert / update / delete of the tables below is collected for a short
 * moment (FLUSH_MS, also lets the transaction commit) and then one socket event
 *   'changed' { deals?: ids | '*', events?: deal ids | '*', tasks?: ..., ... }
 * goes to every connected staff socket (only staff can connect, see
 * NotificationGateWay). The payload carries topics and ids only, never data:
 * the page reloads through the normal API, which applies the user's rights.
 * '*' = the id is unknown (QueryBuilder update / delete): any page of that
 * topic reloads.
 */
type Scope = Set<number> | '*';

// table -> [topic, how to find the id the topic is scoped by]
const TABLES: Record<string, [string, (e: any) => any]> = {
  deal: ['deals', (e) => e?.id],
  deal_stage_record: ['deals', (e) => e?.deal?.id ?? e?.deal_id],
  deal_product: ['deals', (e) => e?.deal?.id ?? e?.deal_id],
  deal_filler: ['deals', (e) => e?.deal?.id ?? e?.deal_id],
  event: ['events', (e) => e?.deal?.id ?? e?.deal_id],
  task: ['tasks', (e) => e?.deal?.id ?? e?.deal_id],
  company: ['companies', (e) => e?.id],
  company_filler: ['companies', (e) => e?.company?.id ?? e?.company_id],
  email: ['emails', (e) => e?.id],
  recording: ['calls', (e) => e?.id],
  trigger_run: ['triggers', (e) => e?.deal?.id ?? e?.deal_id],
  file: ['files', (e) => e?.id],
  deal_stage: ['stages', (e) => e?.id],
  collection: ['stages', (e) => e?.id],
};

// more ids than this in one batch (mail sync, bulk actions): just '*'
const MAX_IDS = 50;
const FLUSH_MS = Number(process.env.LIVE_UPDATES_FLUSH_MS) || 300;

@Injectable()
export class LiveUpdatesSubscriber
  implements EntitySubscriberInterface, OnModuleDestroy {
  private logger = new Logger('LiveUpdates');
  private pending = new Map<string, Scope>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    dataSource: DataSource,
    private gateway: NotificationGateWay,
  ) {
    dataSource.subscribers.push(this);
  }

  afterInsert(e: InsertEvent<any>) {
    this.note(e.metadata?.tableName, e.entity);
  }

  afterUpdate(e: UpdateEvent<any>) {
    this.note(e.metadata?.tableName, e.databaseEntity ?? e.entity);
  }

  afterRemove(e: RemoveEvent<any>) {
    this.note(e.metadata?.tableName, e.databaseEntity ?? e.entity, e.entityId);
  }

  afterSoftRemove(e: SoftRemoveEvent<any>) {
    this.note(e.metadata?.tableName, e.databaseEntity ?? e.entity);
  }

  afterRecover(e: RecoverEvent<any>) {
    this.note(e.metadata?.tableName, e.databaseEntity ?? e.entity);
  }

  private note(table: string | undefined, entity: any, fallbackId?: any) {
    const spec = table && TABLES[table];
    if (!spec) return;
    const [topic, idOf] = spec;
    const id = Number(idOf(entity) ?? (table === 'deal' ? fallbackId : undefined));
    const scope = this.pending.get(topic);

    if (scope === '*') {
      // already "anything of this topic"
    } else if (!Number.isInteger(id) || id <= 0 || scope?.size >= MAX_IDS) {
      this.pending.set(topic, '*');
    } else {
      this.pending.set(topic, (scope ?? new Set<number>()).add(id));
    }

    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    this.timer = null;
    if (!this.pending.size) return;
    const payload: Record<string, number[] | '*'> = {};
    for (const [topic, scope] of this.pending) {
      payload[topic] = scope === '*' ? '*' : [...scope];
    }
    this.pending.clear();
    try {
      this.gateway.server?.emit('changed', payload);
    } catch (err) {
      this.logger.warn(`cannot emit live update: ${err}`);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }
}
