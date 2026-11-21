import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { Email } from './email.entity';

@Index('IDX_email_cc_email', ['email'])
@Entity()
export class EmailCc {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Email, (email) => email.cc, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'email_id' })
  email: Email;

  @Column({ type: 'text' })
  value: string;
}
