import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { Filler } from '../filler/filler.entity';
import { Deal } from './deal.entity';

@Index('IDX_deal_filler_deal', ['deal'])
@Entity()
export class DealFiller {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Deal, (deal) => deal.deal_fillers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @ManyToOne(() => Filler, (filler) => filler.deal_fillers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'filler_id' })
  filler: Filler;

  @Column({ type: 'varchar', length: 255 })
  value: string;

  @CreateDateColumn()
  created_at: Date;
}
