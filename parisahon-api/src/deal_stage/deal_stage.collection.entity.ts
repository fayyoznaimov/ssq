import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { DealStage } from './deal_stage.entity';

@Entity({ name: 'collection' })
export class DealStageCollection {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @OneToMany(() => DealStage, (dealStage) => dealStage.collection, {
    cascade: true,
  })
  deal_stages: DealStage[];

  @Column({ type: 'bool', default: false, nullable: false })
  is_active: boolean;

  @CreateDateColumn()
  created_at: Date;
}
