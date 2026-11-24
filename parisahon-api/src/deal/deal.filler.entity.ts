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
import { Filler } from '../filler/filler.entity';
import { Deal } from './deal.entity';

@Index('IDX_deal_filler_deal', ['deal'])
@Entity()
export class DealFiller {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Deal, (deal) => deal.deal_fillers, {
    onDelete: 'CASCADE',
    // NOT NULL (migration 1795722000000-child-keys-checks); a value dropped from its owner's list is deleted
    nullable: false,
    orphanedRowAction: 'delete',
  })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  // a value without its field is meaningless and a field with values is not deleted by the database
  // (ON DELETE RESTRICT, migration 1795721000000-delete-rules): DELETE /fillers/:id removes the values itself
  @ManyToOne(() => Filler, (filler) => filler.deal_fillers, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'filler_id' })
  filler: Filler;

  @Column({ type: 'varchar', length: 255 })
  value: string;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
