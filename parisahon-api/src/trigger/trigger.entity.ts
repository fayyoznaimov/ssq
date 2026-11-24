import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { DealStage } from '../deal_stage/deal_stage.entity';
import {
  ApplyTriggerWhenEnum,
  ApplyWhenDto,
  DealFilter,
} from './dto/assign.trigger.dto';
import { User } from '../user/user.entity';

export enum TriggerTypes {
  CREATE_TASK = 0,
  CREATE_DEAL = 1,
  SEND_EMAIL = 2,
  CLOSE_TASKS = 3,
  CHANGE_AGENT = 4,
  CHANGE_FIELDS = 5,
  DELETE_FILES = 6,
  // the deal goes to another stage (its triggers run there, one level deeper)
  MOVE_STAGE = 7,
  // a message to the responsible and / or the managers in the CRM bot (a task when the bot cannot)
  NOTIFY = 8,
}

@Index('IDX_trigger_deal_stage', ['deal_stage'])
@Entity()
export class Trigger {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => DealStage, (dealStage) => dealStage.triggers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'deal_stage_id' })
  deal_stage: DealStage;

  @Column({ type: 'smallint', nullable: false })
  type: TriggerTypes;

  // the order of the triggers of a stage: they run in it (then by id), the settings page shows it
  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'varchar', length: 255, name: 'apply_when', nullable: false })
  apply_when: ApplyTriggerWhenEnum;

  @ManyToOne(() => User, (user) => user.targeted_triggers, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'user_id' })
  target_user: User;

  @Column({ type: 'boolean', default: false, name: 'is_delayed' })
  is_delayed: boolean;

  @Column({ type: 'boolean', default: false, name: 'is_recurring' })
  is_recurring: boolean;

  @Column({ type: 'jsonb', nullable: true })
  deal_filters: DealFilter[];

  @Column({ type: 'jsonb', nullable: true })
  apply_when_data: ApplyWhenDto;

  @Column({ type: 'jsonb', nullable: true })
  data: any;

  // deals that entered the stage before this moment do not get the delayed runs of the trigger
  @CreateDateColumn()
  created_at: Date;
}
