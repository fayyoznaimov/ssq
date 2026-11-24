import { User } from 'src/user/user.entity';
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

// This table is being created for statistical purposes only
@Index('IDX_recording_user', ['user'])
// created by migration 1795130000000-perf-indexes (partial / expression indexes): TypeORM must leave them alone
@Index('IDX_recording_created', { synchronize: false })
// the last 9 digits of the number (calls of a company by its phones): migration 1795290000000-call-number-index
@Index('IDX_recording_number_tail', { synchronize: false })
@Entity()
export class Recording {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'duration', type: 'bigint', nullable: false })
  duration: number;

  // the recordings stay when an employee is removed for good (employees are deleted softly):
  // migration 1795721000000-delete-rules
  @ManyToOne(() => User, (user) => user.recordings, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'user_id' })
  user: User; // Not meant for ctr_agents

  @Column({ name: 'outgoing', type: 'bool', default: true })
  outgoing: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'path' })
  path: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'from_number' })
  from_number: string;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
