import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { Deal } from '../deal/deal.entity';
import { Trigger } from '../trigger/trigger.entity';
import { DealStageCollection } from './deal_stage.collection.entity';
import { DealStageRecord } from './deal_stage.records.entity';
import { StageKind } from './stage-kind';

@Index('IDX_deal_stage_collection', ['collection'])
// one stage of each system kind per pipeline (partial: kind <> 'work'), migration 1795620000000
@Index('IDX_deal_stage_collection_kind', { synchronize: false })
@Check('CHK_deal_stage_kind', `"kind" IN ('new', 'first_contact', 'prepayment', 'won', 'lost', 'work')`)
@Entity({ name: 'deal_stage' })
export class DealStage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  color: string;

  /** What the stage means (stage-kind.ts); the name is only its label */
  @Column({ type: 'varchar', length: 16, default: StageKind.WORK })
  kind: StageKind;

  @OneToMany(() => Deal, (deal) => deal.stage)
  deals: Deal[];

  @OneToMany(
    () => DealStageRecord,
    (dealStageRecord) => dealStageRecord.stage,
    { cascade: true },
  )
  deal_records: DealStageRecord[];

  @ManyToOne(
    () => DealStageCollection,
    (collection) => collection.deal_stages,
    {
      nullable: true,
      onDelete: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'collection_id' })
  collection: DealStageCollection;

  @Column({ type: 'smallint', nullable: true })
  order: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  description: string;

  @OneToMany(() => Trigger, (trigger) => trigger.deal_stage)
  triggers: Trigger[];

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
