import { Logger } from '@nestjs/common';
import { EntityManager, EntityMetadata, FindOperator } from 'typeorm';
import { AuditJournal } from './audit-journal';
import { EntitySpec, specOfTable } from './audit-registry';

/**
 * repository.update / delete / softDelete / restore (and the same of an EntityManager) change rows
 * through a query builder: TypeORM tells the subscribers neither which rows nor how they were, so the
 * TypeORM subscriber alone does not see them — and most of the CRM changes companies, contacts,
 * products, fields and settings that way (update(id, {...}), CLAUDE.md). For the tracked tables these
 * calls are wrapped here once: the rows the criteria pick are read before and after the call, in its
 * transaction (one is opened when the caller has none, so the change and its journal row commit
 * together), and the difference goes to the journal (AuditJournal.around).
 *
 * Only criteria the journal can turn into SQL by itself are followed: ids, {column: value},
 * {relation: {id}}, IsNull(), In([...]); anything else runs as before, without a journal row.
 * Nothing changes for the tables the journal does not track or when AUDIT_LOG=0.
 */
const HOOKED = Symbol.for('parisa.audit.manager-hooks');
const METHODS = ['update', 'delete', 'softDelete', 'restore'] as const;
const logger = new Logger('AuditJournal');

export function installManagerHooks(): void {
  const proto = EntityManager.prototype as any;
  if (proto[HOOKED]) return;
  proto[HOOKED] = true;
  for (const method of METHODS) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function audited(this: EntityManager, target: any, criteria: any, ...rest: any[]) {
      let spec: EntitySpec | undefined;
      let where: { sql: string; params: unknown[] } | null = null;
      if (AuditJournal.enabled()) {
        try {
          const metadata = this.connection.getMetadata(target);
          spec = specOfTable(metadata.tableName);
          where = spec ? criteriaSql(metadata, criteria) : null;
        } catch {
          where = null;
        }
      }
      if (!spec || !where) return original.call(this, target, criteria, ...rest);

      const run = (manager: EntityManager) =>
        AuditJournal.around(manager, spec, where.sql, where.params, () => original.call(manager, target, criteria, ...rest));
      if (this.queryRunner?.isTransactionActive) return run(this);
      // the change and its row in one transaction
      return this.transaction((manager) => run(manager));
    };
  }
  logger.log('repository update / delete / softDelete / restore of the tracked tables go to the journal');
}

const primitive = (value: unknown): value is string | number => typeof value === 'number' || typeof value === 'string';

/**
 * TypeORM criteria as a condition on the table `t`, or null when it is not one of the simple forms.
 * An entity (or a condition) that has its primary key: the key alone.
 */
export function criteriaSql(metadata: EntityMetadata, criteria: any): { sql: string; params: unknown[] } | null {
  if (metadata.primaryColumns.length !== 1) return null;
  const pk = metadata.primaryColumns[0];
  const pkSql = `t."${pk.databaseName}"`;
  if (primitive(criteria)) return { sql: `${pkSql} = ANY($1)`, params: [[criteria]] };
  if (Array.isArray(criteria)) {
    if (criteria.length && criteria.every(primitive)) return { sql: `${pkSql} = ANY($1)`, params: [criteria] };
    return null;
  }
  if (!criteria || typeof criteria !== 'object' || criteria instanceof Date || criteria instanceof FindOperator) return null;

  const key = pk.getEntityValue(criteria);
  if (primitive(key)) return { sql: `${pkSql} = ANY($1)`, params: [[key]] };

  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [property, raw] of Object.entries(criteria)) {
    if (raw === undefined) continue;
    const column = metadata.findColumnWithPropertyPath(property);
    if (!column) return null;
    let value: any = raw;
    if (column.relationMetadata && value && typeof value === 'object' && !(value instanceof FindOperator)) {
      const referenced = column.referencedColumn?.propertyName ?? 'id';
      const keys = Object.keys(value);
      if (keys.length !== 1 || keys[0] !== referenced) return null;
      value = value[referenced];
    }
    const name = `t."${column.databaseName}"`;
    if (value === null) {
      parts.push(`${name} IS NULL`);
    } else if (value instanceof FindOperator) {
      if (value.type === 'isNull') parts.push(`${name} IS NULL`);
      else if (value.type === 'in' && Array.isArray(value.value) && value.value.every(primitive)) {
        params.push(value.value);
        parts.push(`${name} = ANY($${params.length})`);
      } else return null;
    } else if (primitive(value) || typeof value === 'boolean') {
      params.push(value);
      parts.push(`${name} = $${params.length}`);
    } else {
      return null;
    }
  }
  return parts.length ? { sql: parts.join(' AND '), params } : null;
}
