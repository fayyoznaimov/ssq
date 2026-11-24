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
    // NOT NULL (migration 1795722000000-child-keys-checks); a recipient dropped from the letter's list is deleted
    nullable: false,
    orphanedRowAction: 'delete',
  })
  @JoinColumn({ name: 'email_id' })
  email: Email;

  @Column({ type: 'text' })
  value: string;
}
