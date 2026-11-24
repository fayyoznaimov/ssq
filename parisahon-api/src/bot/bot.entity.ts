import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { User } from '../user/user.entity';
import { Task } from '../task/task.entity';

/**
 * A CRM user's Telegram chat with the CRM bot. One chat per user and one user
 * per chat: the bot acts as this user, with this user's rights.
 */
@Entity('bot_account')
export class BotAccount {
  @PrimaryColumn({ name: 'user_id' })
  user_id: number;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // Telegram ids exceed 2^31; pg returns bigint as a string
  @Index('IDX_bot_account_chat', { unique: true })
  @Column({ type: 'bigint' })
  chat_id: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  tg_username: string | null;

  /** Local date of the last morning digest, so a restart does not send it twice. */
  @Column({ type: 'date', nullable: true })
  digest_on: string | null;

  @CreateDateColumn({ type: TIME })
  linked_at: Date;
}

/**
 * One-time code of a t.me/<bot>?start=<code> link from the user's profile.
 * Only the SHA-256 of the code is stored.
 */
@Entity('bot_link_code')
export class BotLinkCode {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  code_hash: string;

  @Index('IDX_bot_link_code_user')
  @Column()
  user_id: number;

  @Column({ type: TIME })
  expires_at: Date;
}

/**
 * A task the bot already reminded about (its assignee or its group), and for which start time:
 * a task moved to another time is reminded again before the new start, whoever moved it.
 * TaskService.update also removes the row when the task is handed to someone else.
 */
@Entity('bot_reminder')
export class BotReminder {
  @PrimaryColumn({ name: 'task_id' })
  task_id: number;

  @OneToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  /** the start time of the task that was reminded */
  @Column({ type: TIME, nullable: true })
  start_time: Date | null;

  @CreateDateColumn({ type: TIME })
  sent_at: Date;
}
