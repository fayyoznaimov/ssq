import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { ChildFillerEntity, Filler } from '../filler/filler.entity';
import { User } from './user.entity';

@Index('IDX_user_filler_user', ['user'])
@Entity()
export class UserFiller implements ChildFillerEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.user_fillers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Filler, (filler) => filler.user_fillers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'filler_id' })
  filler: Filler;

  @Column({ type: 'varchar', length: 255 })
  value: string;

  @CreateDateColumn()
  created_at: Date;
}
