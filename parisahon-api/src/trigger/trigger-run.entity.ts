import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Trigger } from './trigger.entity';
import { Deal } from '../deal/deal.entity';

export enum TriggerRunStatus {
  PENDING = 'pending',
  // taken by one execution (a tick of the scheduler or an event): nobody else executes it
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed',
  // not executed on purpose; the reason is in `error` (the deal left the stage, the deal does not
  // fit the conditions, the trigger already fired for the deal, missed by more than a day, ...)
  SKIPPED = 'skipped',
}

/**
 * The schedule of the triggers, in the database.
 *
 * One row = one planned (or finished) execution of a trigger for a deal:
 *  - a delayed trigger ("через 10 минут после перехода", "в точное время")
 *    gets its row when the deal enters the stage;
 *  - a recurring trigger ("ежедневно в 10:00") gets a row for its next
 *    occurrence while the deal stays in the stage;
 *  - immediate triggers get a row too (done / failed), so the history is complete;
 *  - the scheduler takes a due row (pending -> running, one UPDATE: two ticks
 *    never execute the same row) and records the result, so a restart of the
 *    API loses nothing and an error of one trigger is a `failed` row, not a crash.
 * Rows of a deal that leaves the stage are skipped with that reason.
 * At most one pending row per trigger and deal (unique partial index, migration 1795280000000), and
 * one row per trigger, deal and run_key (migration 1795690000000): exactly once.
 */
@Index('IDX_trigger_run_deal', ['deal'])
@Entity('trigger_run')
@Index('IDX_trigger_run_due', ['status', 'run_at'])
@Index('IDX_trigger_run_trigger_deal', ['trigger', 'deal'])
// created by migration 1795280000000-trigger-guards (partial unique index): TypeORM must leave it alone
@Index('IDX_trigger_run_pending', { synchronize: false })
// (trigger, deal, run_key) is unique where run_key is set: migration 1795690000000-trigger-processes
@Index('IDX_trigger_run_key', { synchronize: false })
export class TriggerRun {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Trigger, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'trigger_id' })
  trigger: Trigger;

  @ManyToOne(() => Deal, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @Column({ type: 'timestamp' })
  run_at: Date;

  @Column({ type: 'varchar', length: 16, default: TriggerRunStatus.PENDING })
  status: TriggerRunStatus;

  @Column({ type: 'timestamp', nullable: true, default: null })
  executed_at: Date;

  @Column({ type: 'text', nullable: true, default: null })
  error: string;

  // what a done run did ("создана задача «…»", "удалено файлов: 2 (a.pdf, b.pdf)")
  @Column({ type: 'text', nullable: true, default: null })
  note: string;

  /**
   * What this run is for, unique per trigger and deal (IDX_trigger_run_key): one entry into the stage
   * ("enter:<ms>"), one delayed run of a stay ("delay:<ms>"), one occurrence of a schedule ("at:<ms>"),
   * one message ("event:<key>"), one unanswered client message ("noreply:<event id>"). A second
   * execution of the same thing (two requests, two API processes) cannot insert its row and does nothing.
   */
  @Column({ type: 'varchar', length: 120, nullable: true, default: null })
  run_key: string | null;

  @CreateDateColumn()
  created_at: Date;
}
