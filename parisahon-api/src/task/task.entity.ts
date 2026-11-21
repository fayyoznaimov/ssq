import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../user/user.entity';
import { Company } from '../company/company.entity';
import { Group } from '../group/group.entity';
import { Deal } from '../deal/deal.entity';
import { Event } from '../events/event.entity';
import { TaskType as TaskTypeEntity } from '../task_type/task_type.entity';

export const DefaultTaskRelations = [
  'company',
  'ctr_agent',
  'agent',
  'group',
  'deal',
  'created_by',
  'type',
];

@Index('IDX_task_deal', ['deal'])
@Index('IDX_task_agent', ['agent'])
@Index('IDX_task_company', ['company'])
@Entity()
export class Task {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  label: string;

  @ManyToOne(() => TaskTypeEntity, (taskType) => taskType.tasks, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'type_id' })
  type: TaskTypeEntity;

  @ManyToOne(() => Company, (company) => company.tasks, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @ManyToOne(() => User, (user) => user.assigned_tasks_ctr, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'ctr_agent_id' })
  ctr_agent: User;

  @ManyToOne(() => User, (user) => user.assigned_tasks, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'agent_id' })
  agent: User;

  @ManyToOne(() => Group, (group) => group.assigned_tasks, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'group_id' })
  group: Group;

  @ManyToOne(() => Deal, (deal) => deal.tasks, { nullable: true })
  @JoinColumn({ name: 'deal_id' })
  deal: Deal;

  @OneToMany(() => Event, (event) => event.task)
  events: Event[];

  @Column({ type: 'text', nullable: true })
  result: string;

  @Column({ type: 'timestamp', nullable: true })
  closed_at: Date;

  @Index()
  @Column({ type: 'timestamp' })
  start_time: Date;

  @Index()
  @Column({ type: 'timestamp' })
  end_time: Date;

  // Snake case due to FE requirements
  @Column({ type: 'boolean', default: false })
  allDay: boolean;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => User, (user) => user.created_tasks, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  created_by: User;

  resetAssignTarget(): void {
    this.group = null;
    this.agent = null;
  }

  resetLinkTarget(): void {
    this.company = null;
    this.ctr_agent = null;
    this.deal = null;
  }
}
