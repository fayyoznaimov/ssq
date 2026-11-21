import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  Index,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  DeleteDateColumn,
} from 'typeorm';
import { CompanyFiller } from './company.filler.entity';
import { User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Task } from '../task/task.entity';
import { Notification } from 'src/notification/notification.entity';

@Entity()
export class Company {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  phone: string;

  @Column({ type: 'boolean', default: false })
  is_old: boolean;

  // Requisites. Optional; ИНН is the key for matching with 1C later.
  @Index('IDX_company_inn')
  @Column({ type: 'varchar', length: 20, nullable: true })
  inn: string;

  @Column({ type: 'text', nullable: true })
  legal_address: string;

  @Column({ type: 'varchar', length: 34, nullable: true })
  bank_account: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  bank_name: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  mfo: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  oked: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  director: string;

  @OneToMany(() => CompanyFiller, (companyFiller) => companyFiller.company, {
    cascade: true,
  })
  company_fillers: CompanyFiller[];

  @OneToMany(() => Task, (task) => task.company)
  tasks: Task[];

  @OneToMany(() => Deal, (deal) => deal.company)
  deals: Deal[];

  @OneToMany(() => User, (user) => user.company)
  users: User[];

  @OneToMany(() => Notification, (notifications) => notifications.company)
  notifications: Notification[];

  @ManyToOne(() => User, (user) => user.created_companies, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'created_by' })
  created_by: User;

  // The primary contact: when the company has no phone / email of its own, this contact's
  // are shown and saved as the company's (a company made from a person's card has only those).
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'primary_contact_id' })
  primary_contact: User;

  @ManyToOne(() => User, (user) => user.updated_companies, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'updated_by' })
  updated_by: User;

  @UpdateDateColumn()
  updated_at: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at: Date;

  @CreateDateColumn()
  created_at: Date;
}
