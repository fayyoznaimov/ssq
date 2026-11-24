import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  Index,
  ManyToOne,
  JoinColumn,
  ManyToMany,
  UpdateDateColumn,
  DeleteDateColumn,
  Check,
} from 'typeorm';
import { TIME } from '../helper/time-column';
import { Deal } from '../deal/deal.entity';
import { Group } from '../group/group.entity';
import { Exclude } from 'class-transformer';
import { UserFiller } from './user.filler.entity';
import { Company } from '../company/company.entity';
import { Task } from '../task/task.entity';
import { Event } from '../events/event.entity';
import { File } from '../file/file.entity';
import { EmailTransporter } from '../email/email.transporter.entity';
import { Email } from '../email/email.entity';
import { Product } from '../product/product.entity';
import { EmailTemplate } from '../email/email.template.entity';
import { Trigger } from '../trigger/trigger.entity';
import { Recording } from 'src/analytics/recordings.entity';
import { Objective } from './dto/objective.dto';

export enum RoleEnum {
  ADMIN = 'admin',
  MANAGER = 'manager',
  AGENT = 'agent',
  CTR_AGENT = 'ctr_agent',
}

export const RoleWeights = new Map<RoleEnum, number>();
RoleWeights.set(RoleEnum.CTR_AGENT, 0);
RoleWeights.set(RoleEnum.AGENT, 1);
RoleWeights.set(RoleEnum.MANAGER, 2);
RoleWeights.set(RoleEnum.ADMIN, 3);

export interface UserPermissions {
  deal: FullPermission;
  contact: FullPermission;
  company: FullPermission;
  task: Permission;
  mail: boolean;
  file: boolean;
}

interface FullPermission {
  create: number;
  view: number;
  update: number;
  delete: number;
  export: number;
}

interface Permission {
  update: number;
  delete: number;
}

@Index('IDX_user_company', ['company'])
@Index('IDX_user_tg_id', ['tg_id'])
@Index('IDX_user_wa_id', ['wa_id'])
// digits-only phone lookup of contacts (Telegram, call recordings); created by the migration
@Index('IDX_user_phone_digits', { synchronize: false })
// the last 9 digits of a contact's phone (helper/phone.ts phoneKeySql), migration 1795230000000-people-phones
@Index('IDX_user_phone_key', { synchronize: false })
// created by migration 1795130000000-perf-indexes (partial / expression indexes): TypeORM must leave them alone
@Index('IDX_user_email_lower', { synchronize: false })
@Index('IDX_user_group', { synchronize: false })
// the e-mail is unique among accounts that are not deleted, case and spaces not counted (partial index on
// lower(btrim(email)): migrations 1795240000000-user-email-active, 1795630000000-people-unique)
@Index('IDX_user_email_active', { synchronize: false })
// one of the four roles (RoleEnum): migration 1795722000000-child-keys-checks
@Check('CHK_user_role', `"role" IN ('admin', 'manager', 'agent', 'ctr_agent')`)
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  username: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  phone: string;

  // Secrets are `select: false`: they are not loaded unless a query asks for
  // them with addSelect(), so they cannot leak through JSON.stringify(), events
  // or a controller that forgot instanceToPlain(). @Exclude() stays as a second
  // line of defence for entities that were just created in memory.
  @Exclude()
  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  password: string;

  @Column({ type: 'varchar', length: 255 })
  role: RoleEnum;

  @ManyToOne(() => Group, (group) => group.users, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'group_id' })
  group: Group;

  @OneToMany(() => Recording, (recording) => recording.user)
  recordings: Recording[];

  // a company removed for good leaves its contacts without a company (it used to take them along:
  // migration 1795721000000-delete-rules); the CRM itself deletes companies softly, with their contacts
  @ManyToOne(() => Company, (company) => company.users, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @Column({ type: 'jsonb', nullable: true })
  permissions: UserPermissions;

  @OneToMany(() => Event, (event) => event.originated_by)
  events: Event[];

  @OneToMany(() => Trigger, (trigger) => trigger.target_user)
  targeted_triggers: Trigger[];

  @OneToMany(() => Event, (event) => event.target_user)
  targeted_events: Event[];

  @OneToMany(() => Deal, (deal) => deal.agent)
  assigned_deals: Deal[];

  @OneToMany(() => Deal, (deal) => deal.created_by)
  created_deals: Deal[];

  @OneToMany(() => Task, (task) => task.agent)
  assigned_tasks: Task[];

  @OneToMany(() => Task, (task) => task.ctr_agent)
  assigned_tasks_ctr: Task[];

  @OneToMany(() => Email, (email) => email.from_user)
  sent_emails: Email[];

  @OneToMany(() => EmailTemplate, (emailTemplate) => emailTemplate.created_by)
  email_templates: EmailTemplate[];

  @OneToMany(
    () => EmailTransporter,
    (emailTransporter) => emailTransporter.created_by,
  )
  created_email_transporters: EmailTransporter[];

  // UserFillers are only for users with role CTR_AGENT
  @OneToMany(() => UserFiller, (userFiller) => userFiller.user, {
    cascade: true,
  })
  user_fillers: UserFiller[];

  @OneToMany(() => Task, (task) => task.created_by)
  created_tasks: Task[];

  @OneToMany(() => File, (file) => file.uploaded_by)
  uploaded_files: File[];

  @OneToMany(() => Company, (company) => company.created_by)
  created_companies: Company[];

  @OneToMany(() => Company, (company) => company.updated_by)
  updated_companies: Company[];

  @OneToMany(() => Product, (product) => product.created_by)
  created_products: Product[];

  @OneToMany(() => Product, (product) => product.updated_by)
  updated_products: Product[];

  @ManyToMany(() => Deal, (deal) => deal.ctr_agents)
  linked_deals: Deal[];

  @Exclude()
  @Column({ type: 'integer', nullable: true, default: null, select: false })
  tg_api_id: number;

  @Exclude()
  @Column({ type: 'text', nullable: true, default: null, select: false })
  tg_api_hash: string;

  @Column({ type: 'bigint', nullable: true, default: null })
  tg_id: number;

  // WhatsApp chat id (JID) of a client contact; the phone is matched first
  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  wa_id: string;

  // client's profile photo from Telegram / WhatsApp: a file name in public/uploads
  // raised to sign the user out everywhere (see migrations/1795100000000-token-version.ts)
  @Column({ type: 'integer', default: 0, select: false })
  token_version: number;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  avatar: string;

  // Email signature. Read only through /emails/signs (raw select in EmailService).
  @Exclude()
  @Column({ type: 'text', nullable: true, default: null, select: false })
  sign: string;

  @Column({
    type: 'jsonb',
    nullable: false,
    default: {
      monthly: 0,
      quarterly: 0,
      yearly: 0,
    },
  })
  objectives: Objective;

  @ManyToOne(() => User, (user) => user.created_by, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'created_by' })
  created_by: User;

  @ManyToOne(() => User, (user) => user.updated_by, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'updated_by' })
  updated_by: User;

  @UpdateDateColumn({ type: TIME })
  updated_at: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: TIME })
  deleted_at: Date;

  @ManyToOne(() => User, (user) => user.deleted_by, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'deleted_by' })
  deleted_by: User;

  @CreateDateColumn({ type: TIME })
  created_at: Date;
}
