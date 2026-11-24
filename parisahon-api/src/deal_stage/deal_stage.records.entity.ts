import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { DealStage } from './deal_stage.entity';
import { Deal } from 'src/deal/deal.entity';
import { User } from 'src/user/user.entity';

/**
 * The stage history of a deal: one row per stage the deal entered, with the stage it came from
 * and who moved it (migration 1795620000000-deal-stage-kind). from_stage is null for the first
 * stage of a deal; moved_by is null for a move made by the CRM itself (a trigger, a channel)
 * and for the rows written before the column existed.
 */
@Index('IDX_deal_stage_record_deal', ['deal'])
@Index('IDX_deal_stage_record_from_stage', { synchronize: false })
// time in a stage, the stage reports (stage_id, created_at): migration 1795724000000-key-indexes
@Index('IDX_deal_stage_record_stage', { synchronize: false })
@Entity({ name: 'deal_stage_record' })
export class DealStageRecord {
  @PrimaryGeneratedColumn()
  id: number;

  // NOT NULL (migration 1795722000000-child-keys-checks); history is never changed by the cascade of a
  // deal's or a stage's list: a row missing from a loaded list stays as it is
  @ManyToOne(() => Deal, (deal) => deal.stage_records, { nullable: false, orphanedRowAction: 'disable' })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @ManyToOne(() => DealStage, (dealStage) => dealStage.deal_records, { nullable: false, orphanedRowAction: 'disable' })
  @JoinColumn({ name: 'stage_id' })
  stage: DealStage;

  @ManyToOne(() => DealStage, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'from_stage_id' })
  from_stage: DealStage | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'moved_by' })
  moved_by: User | null;

  @Column({ type: 'bigint', name: 'moved_after_minutes', nullable: true })
  moved_after_minutes: number;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
