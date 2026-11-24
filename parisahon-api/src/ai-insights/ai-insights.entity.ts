import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TIME } from '../helper/time-column';
import { Deal } from '../deal/deal.entity';
import { User } from '../user/user.entity';
import { AiJob } from '../ai/ai-job.entity';
import { ConversationTurn } from '../ai/conversation.entity';

/**
 * The tables of the AI features built on the AI core (migration 1795830000000-ai-insights). Derived data:
 * they go with their deal or employee (ON DELETE CASCADE); a deleted AI job or reviewer only empties the link.
 * Times are `timestamptz` (helper/time-column TIME), like every table after migration 1795729000000.
 */

/**
 * «Разбор нового обращения»: the AI's reading of the first message or letter of a new contact, one row per deal.
 * channel: telegram | whatsapp | email (where the client came from); ai_category: what the AI said — lead (заявка),
 * client (уже клиент), supplier (поставщик), personal (личное), spam, other; category: the same until the owner or
 * the manager corrects it; client_type: wholesale (опт), chain (сеть), hotel (отель), export (экспорт), retail
 * (розница); wants: «что хочет клиент» in one or two sentences; quote: the client's words it is based on (checked
 * to be in the message quote_event_id). has_email: from a letter (people without the "mail" right see the
 * classification only). status: new -> reviewed (the owner looked at it in the list «Новые обращения»).
 * note_event_id: the note in the deal history; notified_at: when the responsible manager was told in the bot.
 */
@Entity('deal_inbound')
@Index('IDX_deal_inbound_deal', { synchronize: false })
@Index('IDX_deal_inbound_category_created', { synchronize: false })
@Index('IDX_deal_inbound_job', { synchronize: false })
@Index('IDX_deal_inbound_reviewed_by', { synchronize: false })
export class DealInbound {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Deal, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @ManyToOne(() => AiJob, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'job_id' })
  job: AiJob | null;

  /** the client's first message (event.id; no foreign key: a message may move to another deal) */
  @Column({ type: 'integer', nullable: true })
  event_id: number | null;

  @Column({ type: 'varchar', length: 16 })
  channel: string;

  @Column({ type: 'boolean', default: false })
  has_email: boolean;

  @Column({ type: 'varchar', length: 16 })
  ai_category: string;

  @Column({ type: 'varchar', length: 16 })
  category: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  country: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  client_type: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  language: string | null;

  @Column({ type: 'text', nullable: true })
  wants: string | null;

  @Column({ type: 'text', nullable: true })
  quote: string | null;

  @Column({ type: 'integer', nullable: true })
  quote_event_id: number | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 16, default: 'new' })
  status: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewed_by' })
  reviewed_by: User | null;

  @Column({ type: TIME, nullable: true })
  reviewed_at: Date | null;

  @Column({ type: TIME, nullable: true })
  notified_at: Date | null;

  @Column({ type: 'integer', nullable: true })
  note_event_id: number | null;

  @Column({ type: 'varchar', length: 32 })
  prompt_version: string;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}

/**
 * «ИИ-супервайзер»: the AI's review of one dialog — the messages of a deal on one day (from_event_id ..
 * to_event_id, Telegram, WhatsApp, e-mail) — against the checklist: greeting (приветствие), need (выявил
 * потребность), answered_all (ответил на все вопросы), politeness (вежливость), next_step (предложил
 * следующий шаг), literacy (грамотность). scores {criterion: 0 нет | 1 частично | 2 да | null не к чему
 * применить}; score: the share of the possible points, 0..100; mistakes [{criterion, quote, event_id,
 * better}] — the manager's words (checked to be in that message) and how to say it better. agent: the
 * employee who wrote to the client that day. Advisory: shown on the control page and in the weekly tips,
 * never part of any rating. has_email: a letter is among the messages (hidden from people without "mail").
 */
@Entity('conversation_review')
@Index('IDX_conversation_review_deal_day', { synchronize: false })
@Index('IDX_conversation_review_agent_day', { synchronize: false })
@Index('IDX_conversation_review_day', { synchronize: false })
@Index('IDX_conversation_review_job', { synchronize: false })
export class ConversationReview {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Deal, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @Column({ type: 'date' })
  day: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'agent_id' })
  agent: User | null;

  @ManyToOne(() => AiJob, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'job_id' })
  job: AiJob | null;

  @Column({ type: 'integer' })
  from_event_id: number;

  @Column({ type: 'integer' })
  to_event_id: number;

  @Column({ type: 'varchar', length: 64, default: '' })
  channels: string;

  @Column({ type: 'boolean', default: false })
  has_email: boolean;

  @Column({ type: 'smallint', default: 0 })
  messages: number;

  @Column({ type: 'jsonb', nullable: true })
  scores: Record<string, number | null> | null;

  @Column({ type: 'smallint', nullable: true })
  score: number | null;

  @Column({ type: 'jsonb', nullable: true })
  mistakes: Record<string, any>[] | null;

  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ type: 'varchar', length: 32 })
  prompt_version: string;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}

/**
 * What the AI features sent to whom, once per kind, employee and day: morning (the morning digest),
 * evening (the evening digest), tips (the weekly «3 ошибки»). delivered: the bot accepted the message.
 */
@Entity('ai_notice')
@Index('IDX_ai_notice_kind_user_day', { synchronize: false })
@Index('IDX_ai_notice_user', { synchronize: false })
export class AiNotice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16 })
  kind: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'date' })
  day: string;

  @Column({ type: 'boolean', default: false })
  delivered: boolean;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}

/**
 * «Рынок»: what a client said about the market in a turn the AI core analysed (a turn with the flag competitor,
 * price_objection or discount, or with a target price). kind: competitor (another supplier's offer), client_target
 * (the price the client wants), our (the price our manager named). supplier / country: who offers it;
 * product, size, grammage: what (as said); price + currency + unit: one unit's price as a number (null when no
 * number was said; price_text — as written); moq, delivery, quality, payment: the terms as said. quote: the words
 * it comes from (checked to be in the message event_id). mentioned_at: the time of that message. has_email: from
 * a letter (hidden from people without the "mail" right). The rows of a turn are replaced when it is read again.
 */
@Entity('market_mention')
@Index('IDX_market_mention_deal', { synchronize: false })
@Index('IDX_market_mention_turn', { synchronize: false })
@Index('IDX_market_mention_at', { synchronize: false })
@Index('IDX_market_mention_job', { synchronize: false })
export class MarketMention {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Deal, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @ManyToOne(() => ConversationTurn, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'turn_id' })
  turn: ConversationTurn;

  @ManyToOne(() => AiJob, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'job_id' })
  job: AiJob | null;

  /** the message it was said in (event.id; no foreign key: a message may move to another deal) */
  @Column({ type: 'integer', nullable: true })
  event_id: number | null;

  @Column({ type: 'varchar', length: 16 })
  kind: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  supplier: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  country: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  product: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  size: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  grammage: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  price: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  currency: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  unit: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  price_text: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  moq: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  delivery: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  quality: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  payment: string | null;

  @Column({ type: 'text', nullable: true })
  quote: string | null;

  @Column({ type: 'boolean', default: false })
  has_email: boolean;

  @Column({ type: TIME })
  mentioned_at: Date;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
