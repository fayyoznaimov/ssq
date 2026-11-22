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

  @Column({ type: 'varchar', length: '255', nullable: true })
  field_of: FieldsOf;

  @Column({ type: 'jsonb', nullable: true })
  before_state: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  after_state: Record<string, any>;

  @CreateDateColumn()
  created_at: Date;
}
