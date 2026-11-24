import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { User } from '../user/user.entity';
import { Group } from '../group/group.entity';
import { Task } from '../task/task.entity';
import { Company } from '../company/company.entity';

export enum EventTypes {
  NEW_DEAL = 0,
  NEW_CTR_AGENT = 1,
  NEW_COMPANY = 2,
  NEW_FIELD_VALUE = 3,
  NEW_UPDATED_FIELD_VALUE = 4,
  NEW_COMMENT = 5,
  NEW_TASK = 6,
  NEW_TASK_STATUS = 7,
  NEW_CHAT_MESSAGE = 8,
  NEW_EMAIL = 9,
  NEW_CALL_RECORDING = 10,
  NEW_SMS = 11,
  NEW_TELEGRAM_MESSAGE = 12,
  NEW_TELEGRAM_CALL = 13,
  NEW_PRODUCT = 14,
  NEW_DEAL_STAGE = 15,
  NEW_WHATSAPP_MESSAGE = 16,
  // a task was changed (PATCH /tasks/:id): who changed it, the version before and after;
  // the NEW_TASK entry of its creation stays as it was written
  NEW_TASK_UPDATE = 17,
  // a letter or a message was moved to another deal: the trace in the deal it left
  // (after_state.data: event_id, type, to_deal)
  EVENT_MOVED = 18,
}

export enum FieldsOf {
  COMPANY = 'company',
  DEAL = 'deal',
  USER = 'user',
  PRODUCT = 'product',
}

@Index('IDX_event_deal_created', ['deal', 'created_at'])
@Index('IDX_event_user', ['originated_by'])
@Index('IDX_event_target_user', ['target_user'])
@Index('IDX_event_task', ['task'])
// created by migration 1795130000000-perf-indexes (partial / expression indexes): TypeORM must leave them alone
@Index('IDX_event_type_created', { synchronize: false })
@Index('IDX_event_chat_deal', { synchronize: false })
@Index('IDX_event_chat_unreplied', { synchronize: false })
@Index('IDX_event_deal_tg_message', { synchronize: false })
// the history entries of a letter (after_state.data.id of type 9), migration 1795260000000-mail-threads
@Index('IDX_event_email_id', { synchronize: false })
// one row per messenger message: unique (account, chat, message id), migration 1795680000000-messenger-message-key
@Index('IDX_event_tg_message_key', { synchronize: false })
@Index('IDX_event_wa_message_key', { synchronize: false })
// the client feeds by the client of the event (company_id / contact_id), migration 1795610000000-event-client
@Index('IDX_event_company_created', { synchronize: false })
@Index('IDX_event_contact_created', { synchronize: false })
@Entity()
export class Event {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ type: 'smallint' })
  type: EventTypes;

  @Column({ type: 'boolean', nullable: false, default: true })
  outgoing: boolean;

  @Column({ type: 'bigint', nullable: true, default: null })
  tg_message_id: number;

  // id of the message in another messenger (WhatsApp: a string)
  @Index('IDX_event_external_id')
  @Column({ type: 'varchar', length: 128, nullable: true, default: null })
  external_id: string;

  @Column({ type: 'bigint', nullable: true, default: null })
  duration: number;

  @Column({ type: 'timestamp', nullable: true, default: null })
  replied_at: Date;

  @ManyToOne(() => Deal, (deal) => deal.events, { nullable: true })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @ManyToOne(() => Task, (task) => task.events, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @ManyToOne(() => User, (user) => user.events, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'user_id' })
  originated_by: User;

  @ManyToOne(() => User, (user) => user.targeted_events, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'target_user_id' })
  target_user: User;

  @ManyToOne(() => Group, (group) => group.events, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'target_group_id' })
  target_group: Group;

  /**
   * The client the event is about (DB-9): the company and the contact of its client card. Set on insert
   * by EventClientSubscriber from what the event names (the contact or company itself, the task, the
   * client among its people, the deal's company), filled for older rows by migration
   * 1795610000000-event-client. The feeds of a company and a contact read them, not the JSON snapshots.
   * An event of a deal concerns all the deal's contacts: those come by the deal (deal_user), contact_id
   * names only the one person it is with or about (a message, a call, a task, a change of their card).
   */
  @Column({ type: 'int', nullable: true, default: null })
  company_id: number | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @Column({ type: 'int', nullable: true, default: null })
  contact_id: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'contact_id' })
  contact: User;

  @Column({ type: 'varchar', length: '255', nullable: true })
  field_of: FieldsOf;

  @Column({ type: 'jsonb', nullable: true })
  before_state: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  after_state: Record<string, any>;

  /**
   * Where the entry came from (TRG-5, AUDIT-11): web, bot, trigger, autopilot, telegram, whatsapp, ftp,
   * ai, mail, system, and what exactly ("trigger:42"). Set on insert from the request context by the
   * journal (src/audit/audit.subscriber.ts), migration 1795810000000-audit-log; null for older rows.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  source: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  source_ref: string | null;

  @CreateDateColumn()
  created_at: Date;
}
