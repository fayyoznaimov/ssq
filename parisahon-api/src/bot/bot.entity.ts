import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
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

  @CreateDateColumn()
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

  @Column({ type: 'timestamp' })
  expires_at: Date;
}

/** A task the bot already reminded about. */
@Entity('bot_reminder')
export class BotReminder {
  @PrimaryColumn({ name: 'task_id' })
  task_id: number;

  @OneToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @CreateDateColumn()
  sent_at: Date;
}
