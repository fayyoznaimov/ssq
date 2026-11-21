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

// This table is being created for statistical purposes only
@Index('IDX_recording_user', ['user'])
@Entity()
export class Recording {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'duration', type: 'bigint', nullable: false })
  duration: number;

  @ManyToOne(() => User, (user) => user.recordings, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User; // Not meant for ctr_agents

  @Column({ name: 'outgoing', type: 'bool', default: true })
  outgoing: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'path' })
  path: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'from_number' })
  from_number: string;

  @CreateDateColumn()
  created_at: Date;
}
