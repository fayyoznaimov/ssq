import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Check,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { User } from '../user/user.entity';
import { Recording } from '../analytics/recordings.entity';

export enum CallUploadStatus {
  PENDING = 'pending',
  DONE = 'done',
  FAILED = 'failed',
  DISCARDED = 'discarded',
  // a second copy of a call that is there already (cut off, then whole): only the longer copy is kept
  DUPLICATE = 'duplicate',
}

/**
 * The queue of received call recordings: one row per file the recorder (or the
 * folder scanner of the Telegram service) sent to POST /calls/upload. The
 * processor (CallsService.processPending) converts it to mp3, writes the
 * `recording` row, links it to the deals of the client with that number and
 * records the outcome here; a broken file fails alone.
 */
// (user_id, file_hash) serves the lookups by user too: the index of user_id alone is gone (1795724000000-key-indexes)
@Index('IDX_call_upload_hash', ['user', 'file_hash'])
@Entity('call_upload')
@Index('IDX_call_upload_status', ['status', 'received_at'])
// one of CallUploadStatus: migration 1795722000000-child-keys-checks
@Check('CHK_call_upload_status', `"status" IN ('pending', 'done', 'failed', 'discarded', 'duplicate')`)
export class CallUpload {
  @PrimaryGeneratedColumn()
  id: number;

  // the manager whose phone recorded the call; the queue stays when an employee is removed for good
  // (employees are deleted softly): migration 1795721000000-delete-rules
  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 255 })
  file_name: string;

  // the raw file as received, inside public/uploads (deleted after a successful conversion)
  @Column({ type: 'varchar', length: 255 })
  raw_path: string;

  @Column({ type: 'bigint', nullable: true, default: null })
  duration: number;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  from_number: string;

  @Column({ type: 'boolean', default: true })
  outgoing: boolean;

  @Column({ type: 'varchar', length: 32, default: 'recorder' })
  source: string;

  // SHA-256 of the received file: the same file of the same manager is queued once
  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  file_hash: string;

  // the moment of the call (from the name of the file, else the time of the file on the phone)
  @Column({ type: TIME, nullable: true, default: null })
  recorded_at: Date;

  // the name from the manager's phone book, when the recorder gives no number (messenger calls)
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  caller_name: string;

  @Column({ type: 'varchar', length: 16, default: CallUploadStatus.PENDING })
  status: CallUploadStatus;

  @Column({ type: 'text', nullable: true, default: null })
  error: string;

  @ManyToOne(() => Recording, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'recording_id' })
  recording: Recording;

  @CreateDateColumn({ name: 'received_at', type: TIME })
  received_at: Date;

  @Column({ type: TIME, nullable: true, default: null })
  processed_at: Date;
}
