import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  ManyToMany,
  JoinTable,
  OneToMany,
} from 'typeorm';
import { User } from '../user/user.entity';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { Company } from '../company/company.entity';
import { DealFiller } from './deal.filler.entity';
import { Task } from '../task/task.entity';
import { Event } from '../events/event.entity';
import { File } from '../file/file.entity';
import { DealProduct } from './deal-product.entity';
import { DealStageRecord } from 'src/deal_stage/deal_stage.records.entity';

@Index('IDX_deal_stage', ['stage'])
@Index('IDX_deal_agent', ['agent'])
@Index('IDX_deal_company', ['company'])
@Index('IDX_deal_repeat_of', ['repeat_of'])
// created by migration 1795130000000-perf-indexes (partial / expression indexes): TypeORM must leave them alone
@Index('IDX_deal_created', { synchronize: false })
@Index('IDX_deal_closed', { synchronize: false })
@Index('IDX_deal_open_stage', { synchronize: false })
@Index('IDX_deal_created_by', { synchronize: false })
@Entity()
export class Deal {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  label: string;

  @Index('IDX_deal_display_id', { unique: true })
  @Column()
  display_id: number;

  @Column({ type: 'bigint', nullable: true })
  budget: number;

  @OneToMany(() => DealFiller, (dealFiller) => dealFiller.deal, {
    cascade: true,
  })
  deal_fillers: DealFiller[];

  @OneToMany(() => DealStageRecord, (dealStageRecord) => dealStageRecord.deal, {
    cascade: true,
  })
  stage_records: DealStageRecord[];

  @ManyToMany(() => File, (file) => file.deals, { cascade: true })
  files: File[];

  @OneToMany(() => Task, (task) => task.deal)
  tasks: Task[];

  @OneToMany(() => Event, (event) => event.deal)
  events: Event[];

  @ManyToOne(() => DealStage, (dealStage) => dealStage.deals)
  @JoinColumn({ name: 'stage_id' })
  stage: DealStage;

  @Column({ type: 'timestamp', nullable: true, default: null })
  last_stage_change: Date;

  @ManyToOne(() => User, (user) => user.assigned_deals, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'agent_id' })
  agent: User;

  @ManyToMany(() => User, (user) => user.linked_deals)
  @JoinTable({ name: 'deal_user' })
  ctr_agents: User[];

  @OneToMany(() => DealProduct, (dealProduct) => dealProduct.deal, {
    cascade: true,
  })
  deal_products: DealProduct[];

  @ManyToOne(() => User, (user) => user.created_deals, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'created_by' })
  created_by: User;

  @ManyToOne(() => Company, (company) => company.deals, {
    nullable: true,
  })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  // "повторное обращение": the client's previous deal (deals from Telegram / WhatsApp)
  @ManyToOne(() => Deal, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'repeat_of_id' })
  repeat_of: Deal;

  @CreateDateColumn()
  created_at: Date;

  @Column({ type: 'timestamp', nullable: true, default: null })
  closed_at: Date;

  /**
   * Soft delete = the trash of deals (DealTrashService).
   * TypeORM hides rows with deleted_at from find*, QueryBuilder and joins.
   * Raw SQL has to filter by "deleted_at IS NULL" on its own.
   */
  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at: Date;

  /** Who moved the deal to the trash (DELETE /deals/:id), null while it is not there */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'deleted_by' })
  deleted_by: User;
}
