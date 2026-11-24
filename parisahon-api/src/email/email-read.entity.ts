import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { TIME } from '../helper/time-column';
import { User } from '../user/user.entity';
import { Email } from './email.entity';

/**
 * «Прочитано» of a letter for one staff member: who opened it in Mail. It used to be one flag for
 * everybody (email.read, the \Seen of the server), so whoever opened a letter first read it for
 * everyone in Cc. email.read stays the flag of the mail server.
 */
@Index('IDX_email_read_user', { synchronize: false })
@Entity('email_read')
export class EmailRead {
  @PrimaryColumn({ type: 'integer' })
  email_id: number;

  @PrimaryColumn({ type: 'integer' })
  user_id: number;

  @ManyToOne(() => Email, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'email_id' })
  email: Email;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: TIME, default: () => 'now()' })
  read_at: Date;
}
