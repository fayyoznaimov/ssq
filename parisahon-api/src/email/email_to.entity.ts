import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { Email } from './email.entity';

@Index('IDX_email_to_email', ['email'])
@Entity()
export class EmailTo {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Email, (email) => email.to, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'email_id' })
  email: Email;

  @Column({ type: 'text' })
  value: string;
}
