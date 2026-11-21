import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../user/user.entity';

/**
 * The token of the call recorder of one manager (the recorder app on the
 * phone sends every call to POST /calls/upload with it). Only the SHA-256 of
 * the token is stored; the value itself is shown once when the admin issues it.
 */
@Entity('recorder_token')
export class RecorderToken {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Index('IDX_recorder_token_hash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  token_hash: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  created_by: User;

  @CreateDateColumn()
  created_at: Date;

  @Column({ type: 'timestamp', nullable: true, default: null })
  revoked_at: Date;

  @Column({ type: 'timestamp', nullable: true, default: null })
  last_upload_at: Date;
}
