import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * audit_log: the journal «кто что изменил» (migration 1795810000000-audit-log).
 *
 * Immutable: a database trigger refuses UPDATE and DELETE (only the nightly cleanup by
 * AUDIT_RETENTION_DAYS may delete, with the session switch parisa.audit_purge). Written in the
 * transaction of the change itself (AuditJournal, the TypeORM subscriber): a change that is rolled
 * back leaves no row, a committed one always has its row. No foreign keys: a row outlives the deal,
 * the user or the company it is about (the trash purge, a deleted employee).
 *
 * One row = one object in one operation. `batch` groups the rows of one operation (a request, a run
 * of a trigger, a tick of a job); `changes` holds {column: [old, new]} of what changed, before_state /
 * after_state the whole object before and after (secrets — passwords, hashes, tokens, signatures —
 * never: only the fact that they changed; long texts shortened). Rows of action 'baseline' are the
 * state of every object when the journal was switched on: not events, not shown as news.
 */
@Index('IDX_audit_log_entity', { synchronize: false })
@Index('IDX_audit_log_deal', { synchronize: false })
@Index('IDX_audit_log_company', { synchronize: false })
@Index('IDX_audit_log_contact', { synchronize: false })
@Index('IDX_audit_log_actor', { synchronize: false })
@Index('IDX_audit_log_at', { synchronize: false })
@Index('IDX_audit_log_batch', { synchronize: false })
@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  at: Date;

  /** the save group: the rows of one operation */
  @Column({ type: 'varchar', length: 36 })
  batch: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  request_id: string | null;

  /** the person; null for automation (triggers, the autopilot, the receivers) and the system */
  @Column({ type: 'integer', nullable: true })
  actor_id: number | null;

  /** the name at that moment: the row stays readable when the account is renamed or deleted */
  @Column({ type: 'varchar', length: 255, nullable: true })
  actor_name: string | null;

  /** web, bot, trigger, autopilot, telegram, whatsapp, ftp, ai, mail, system (audit-context.ts) */
  @Column({ type: 'varchar', length: 16, default: 'system' })
  source: string;

  /** "trigger:42" and the like */
  @Column({ type: 'varchar', length: 64, nullable: true })
  source_ref: string | null;

  /** deal, deal_product, deal_filler, company, contact, user, task, product, file, trigger, … (audit-registry.ts) */
  @Column({ type: 'varchar', length: 32 })
  entity: string;

  @Column({ type: 'bigint', nullable: true })
  entity_id: string | null;

  /** insert, update, delete, soft_delete, restore, permissions, settings, login, logout, login_failed, baseline */
  @Column({ type: 'varchar', length: 16 })
  action: string;

  @Column({ type: 'jsonb', nullable: true })
  changes: Record<string, [unknown, unknown]> | null;

  @Column({ type: 'jsonb', nullable: true })
  before_state: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after_state: Record<string, unknown> | null;

  /** a line in Russian, also for the text search */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  /** the deal, company and contact the row is about: the histories of their cards */
  @Column({ type: 'integer', nullable: true })
  deal_id: number | null;

  @Column({ type: 'integer', nullable: true })
  company_id: number | null;

  @Column({ type: 'integer', nullable: true })
  contact_id: number | null;

  /** the rest: the address and browser of a login, the person who set a trigger off, … */
  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, unknown> | null;
}
