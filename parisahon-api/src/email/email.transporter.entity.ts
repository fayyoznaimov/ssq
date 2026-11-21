import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
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

  @CreateDateColumn()
  created_at: Date;
}
