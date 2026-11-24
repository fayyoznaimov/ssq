import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../user/user.entity';

export type AiJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

/**
 * One request to the AI (migration 1795820000000-ai-core), the queue of AiQueueService.
 *
 * kind: what is asked ("turn" — analysis of a turn of a deal's conversation, "summary" — the deal
 * summary); entity / entity_id: what it is about ("deal", id); input: what the handler needs to build
 * the prompt again (event ids, the mail flag); input_hash: SHA-256 of the prompt version and the data
 * of the prompt — unique per kind (IDX_ai_job_input), so the same input never goes to the CLI twice:
 * a second request with it gets the stored result.
 * priority: 0 a person waits (button, bot), 1 an event (a new turn), 2 a nightly batch; the worker
 * takes the smallest first and keeps one CLI slot free for people.
 * status: queued -> running -> done | failed | skipped (the deal was closed meanwhile, ...).
 * attempts: CLI tries; a broken answer is tried again (AI_MAX_ATTEMPTS), a usage limit is not counted.
 */
@Entity('ai_job')
@Index('IDX_ai_job_input', { synchronize: false })
@Index('IDX_ai_job_queue', { synchronize: false })
@Index('IDX_ai_job_entity', { synchronize: false })
@Index('IDX_ai_job_requested_by', { synchronize: false })
export class AiJob {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 32 })
  kind: string;

  @Column({ type: 'varchar', length: 32 })
  entity: string;

  @Column({ type: 'integer' })
  entity_id: number;

  @Column({ type: 'varchar', length: 64 })
  input_hash: string;

  @Column({ type: 'jsonb', nullable: true })
  input: Record<string, any> | null;

  @Column({ type: 'smallint' })
  priority: number;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status: AiJobStatus;

  @Column({ type: 'smallint', default: 0 })
  attempts: number;

  @Column({ type: 'timestamp', default: () => 'now()' })
  run_after: Date;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, any> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'varchar', length: 32 })
  prompt_version: string;

  /** the model the CLI reported */
  @Column({ type: 'varchar', length: 64, nullable: true })
  model: string | null;

  /** who pressed the button (interactive jobs) */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'requested_by' })
  requested_by: User | null;

  @CreateDateColumn()
  created_at: Date;

  @Column({ type: 'timestamp', nullable: true })
  started_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  finished_at: Date | null;

  @Column({ type: 'integer', nullable: true })
  duration_ms: number | null;
}

/**
 * CLI calls of the AI per local day: the budget of background jobs (AI_DAILY_BUDGET) counts
 * background_calls of today. paused_until: all AI waits until then (the CLI reported the usage limit
 * of the subscription, or did not work at all); pause_reason says why (GET /ai/status, the deal page).
 */
@Entity('ai_usage')
export class AiUsage {
  @PrimaryColumn({ type: 'date' })
  day: string;

  @Column({ type: 'integer', default: 0 })
  background_calls: number;

  @Column({ type: 'integer', default: 0 })
  interactive_calls: number;

  @Column({ type: 'integer', default: 0 })
  limit_hits: number;

  @Column({ type: 'timestamp', nullable: true })
  paused_until: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  pause_reason: string | null;
}
