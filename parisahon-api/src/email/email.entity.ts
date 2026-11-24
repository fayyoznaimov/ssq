import {
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { EmailTo } from './email_to.entity';
import { EmailCc } from './email_cc.entity';
import { User } from '../user/user.entity';
import { File } from '../file/file.entity';

/**
 * We are choosing to save minimal copy of emails in our database as well.
 * This is done to optimize calculating statistics and to have more control
 * over the emails.
 */
// created by migration 1795130000000-perf-indexes (partial / expression indexes): TypeORM must leave them alone
@Index('IDX_email_mailbox_uid', { synchronize: false })
@Index('IDX_email_mailbox_sent', { synchronize: false })
@Index('IDX_email_user', { synchronize: false })
// the letters an employee sent (the mailbox): migration 1795724000000-key-indexes
@Index('IDX_email_sent_by', { synchronize: false })
@Entity()
export class Email {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint', nullable: true })
  email_id: number;

  /**
   * Email address of the sender
   */
  @Index()
  @Column({ type: 'text', nullable: true })
  from: string;

  /**
   * This is user reference
   * Ctr_agent that has the same email address from which the email was sent
   */
  @ManyToOne(() => User, (user) => user.sent_emails, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'user_id' })
  from_user: User;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    default: null,
    name: 'thread_id',
  })
  thread_id: string;

  /**
   * RFC 5322 Message-ID header. Unlike the IMAP uid (email_id) it survives a
   * UIDVALIDITY change of the mailbox, so it is what the local copy is matched
   * against when the server renumbers a folder.
   */
  @Index()
  @Column({ type: 'varchar', length: 998, nullable: true, default: null })
  message_id: string;

  /**
   * UIDVALIDITY of `from_mailbox` at the time `email_id` was recorded. Postgres
   * bigint comes back as a string. NULL on rows saved before it was tracked.
   */
  @Column({ type: 'bigint', nullable: true, default: null })
  uidvalidity: string;

  /**
   * The staff member who sent this email from the CRM. Together with the
   * addresses it decides who may open or delete the email.
   */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sent_by_id' })
  sent_by: User;

  /** The display name of the sender ("Ivan Petrov" of `Ivan Petrov <ivan@x>`): the name of a contact made from the letter. */
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  from_name: string;

  /**
   * In-Reply-To / References: the Message-IDs of the letters this one answers. A reply finds its
   * thread through them (the deals of the letter answered, the agent who wrote it).
   */
  @Column({ type: 'varchar', length: 998, nullable: true, default: null })
  in_reply_to: string;

  @Column({ type: 'text', nullable: true, default: null })
  reference_ids: string;

  /**
   * The HTML part of a received letter as it came (the client cleans it before showing it); `body`
   * keeps the text. Not selected by default: lists and the deal history do not carry it.
   */
  @Column({ type: 'text', nullable: true, default: null, select: false })
  html: string;

  /** Who deleted the letter in the CRM (moved it to the Trash mailbox); deleted_at says when. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'deleted_by_id' })
  deleted_by: User;

  @Column({ type: 'text', nullable: true })
  subject: string;

  @OneToMany(() => EmailTo, (emailTo) => emailTo.email, {
    cascade: true,
  })
  to: EmailTo[];

  @OneToMany(() => File, (file) => file.email, {
    cascade: true,
  })
  files: File[];

  @OneToMany(() => EmailCc, (emailCc) => emailCc.email, {
    cascade: true,
    onDelete: 'CASCADE',
  })
  cc: EmailCc[];

  @Column({ type: 'boolean', default: false })
  outgoing: boolean;

  @Column({ type: 'text', nullable: true })
  body: string;

  @Column({ type: TIME, nullable: true })
  sent_at: Date;

  @Column({ type: 'boolean', default: false })
  read: boolean;

  @Column({ type: 'boolean', default: false })
  is_spam: boolean;

  /**
   * We need to save the mailbox from which the email was received to avoid email_id collisions
   */
  @Column({
    type: 'varchar',
    length: 255,
    default: 'INBOX',
  })
  from_mailbox: string;

  @DeleteDateColumn({ name: 'deleted_at', type: TIME })
  deleted_at: Date;
}
