import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { User } from '../user/user.entity';
import { Exclude } from 'class-transformer';

@Entity({ name: 'email_transporter' })
export class EmailTransporter {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Exclude()
  @Column({ type: 'varchar', length: 255 })
  password: string;

  @ManyToOne(() => User, (user) => user.created_email_transporters, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  created_by: User;

  /**
   * When the mail server last accepted this address and password (checked on every save). Only a
   * checked mailbox shows its letters to its owner; one saved before the check existed does not.
   */
  @Column({ type: TIME, nullable: true, default: null })
  verified_at: Date;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
