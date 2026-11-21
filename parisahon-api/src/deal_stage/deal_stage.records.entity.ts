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

@Index('IDX_deal_stage_record_deal', ['deal'])
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

  @Column({ type: 'bigint', name: 'moved_after_minutes', nullable: true })
  moved_after_minutes: number;

  @CreateDateColumn()
  created_at: Date;
}
