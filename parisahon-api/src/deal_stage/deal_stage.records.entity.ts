import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
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
@Entity({ name: 'deal_stage_record' })
export class DealStageRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Deal, (deal) => deal.stage_records)
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @ManyToOne(() => DealStage, (dealStage) => dealStage.deal_records)
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

  @CreateDateColumn()
  created_at: Date;
}
