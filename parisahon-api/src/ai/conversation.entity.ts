import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { Task } from '../task/task.entity';
import { User } from '../user/user.entity';
import { AiJob } from './ai-job.entity';

/**
 * «Разбор хода» (migration 1795820000000-ai-core): one AI analysis of a turn of a deal's conversation
 * — the client's messages (Telegram, WhatsApp, e-mail) and the manager's answer — from_event_id ..
 * to_event_id. The next turn of the deal starts after to_event_id (unique per deal).
 * unanswered_questions [{text, event_id}], promises [{who, what, due, event_id}], order_params
 * {product, size, grammage, color, quantity, packaging, logo, country, deadline, target_price},
 * flags [complaint, discount, competitor, price_objection, rude], language, summary — as the model
 * answered (checked by ai-prompts.ts). has_email: a letter is among the messages (people without the
 * "mail" right do not see this turn). Questions and promises to follow are in conversation_item.
 */
@Entity('conversation_turn')
@Index('IDX_conversation_turn_deal_end', { synchronize: false })
@Index('IDX_conversation_turn_job', { synchronize: false })
export class ConversationTurn {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Deal, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @ManyToOne(() => AiJob, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'job_id' })
  job: AiJob | null;

  @Column({ type: 'integer' })
  from_event_id: number;

  @Column({ type: 'integer' })
  to_event_id: number;

  /** the client's first message of the turn */
  @Column({ type: 'timestamp', nullable: true })
  client_at: Date | null;

  /** the manager's last answer of the turn */
  @Column({ type: 'timestamp', nullable: true })
  answered_at: Date | null;

  /** "telegram,whatsapp,email": the channels of the messages */
  @Column({ type: 'varchar', length: 64, default: '' })
  channels: string;

  @Column({ type: 'boolean', default: false })
  has_email: boolean;

  @Column({ type: 'jsonb', nullable: true })
  unanswered_questions: Record<string, any>[] | null;

  @Column({ type: 'jsonb', nullable: true })
  promises: Record<string, any>[] | null;

  @Column({ type: 'jsonb', nullable: true })
  order_params: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  flags: string[] | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  language: string | null;

  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ type: 'varchar', length: 32 })
  prompt_version: string;

  @CreateDateColumn()
  created_at: Date;
}

/**
 * A question of the client left without an answer, or a promise (of the manager or of the client),
 * found by a turn analysis and followed until it is done:
 *  - status open -> done (close_reason "answered" / "fulfilled": a later analysis saw it; "task_closed":
 *    the manager closed its task) or dismissed (the manager pressed «Снять» on the deal page);
 *  - task_id: the task «Авто (ИИ): …» made for it (tasked_at: when; a deleted task is not made again).
 * has_email: the item comes from a letter (hidden from people without the "mail" right).
 */
@Entity('conversation_item')
@Index('IDX_conversation_item_deal_status', { synchronize: false })
@Index('IDX_conversation_item_turn', { synchronize: false })
@Index('IDX_conversation_item_task', { synchronize: false })
@Index('IDX_conversation_item_closed_by', { synchronize: false })
export class ConversationItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Deal, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @ManyToOne(() => ConversationTurn, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'turn_id' })
  turn: ConversationTurn;

  /** question | promise */
  @Column({ type: 'varchar', length: 16 })
  kind: string;

  /** promises: manager | client */
  @Column({ type: 'varchar', length: 16, nullable: true })
  who: string | null;

  @Column({ type: 'varchar', length: 500 })
  text: string;

  /** the message it comes from (event.id; no foreign key: a message may move to another deal) */
  @Column({ type: 'integer', nullable: true })
  event_id: number | null;

  @Column({ type: 'boolean', default: false })
  has_email: boolean;

  /** promises: the promised time (local); due_has_time false = only the day was named */
  @Column({ type: 'timestamp', nullable: true })
  due_at: Date | null;

  @Column({ type: 'boolean', default: false })
  due_has_time: boolean;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  close_reason: string | null;

  @Column({ type: 'timestamp', nullable: true })
  closed_at: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'closed_by' })
  closed_by: User | null;

  @ManyToOne(() => Task, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'task_id' })
  task: Task | null;

  @Column({ type: 'timestamp', nullable: true })
  tasked_at: Date | null;

  @CreateDateColumn()
  created_at: Date;
}
