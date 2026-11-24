import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Company } from '../../company/company.entity';
import { Deal } from '../../deal/deal.entity';
import { User } from '../../user/user.entity';
import { Group } from '../../group/group.entity';
import { Type } from '@nestjs/common';
import { Type as TypeDecorator } from 'class-transformer';
import { Trim } from '../../helper/validators';

export type ExchangeableEntities = Company | User | Group | Deal;

export enum ViableAssignTargets {
  GROUP = 'group',
  AGENT = 'agent',
}

export enum ViableLinkTargets {
  COMPANY = 'company',
  DEAL = 'deal',
  CTR_AGENT = 'ctr_agent',
}

export const TargetToEntityMapping: Record<
  ViableAssignTargets | ViableLinkTargets,
  Type<ExchangeableEntities>
> = {
  [ViableLinkTargets.COMPANY]: Company,
  [ViableLinkTargets.DEAL]: Deal,
  [ViableAssignTargets.AGENT]: User,
  [ViableLinkTargets.CTR_AGENT]: User,
  [ViableAssignTargets.GROUP]: Group,
};

export const TargetToEntityAttributeMapping: Record<
  ViableAssignTargets | ViableLinkTargets,
  string
> = {
  [ViableLinkTargets.COMPANY]: 'company',
  [ViableLinkTargets.DEAL]: 'deal',
  [ViableAssignTargets.AGENT]: 'agent',
  [ViableLinkTargets.CTR_AGENT]: 'ctr_agent',
  [ViableAssignTargets.GROUP]: 'group',
};

export class AssignToDto {
  @IsString()
  @IsEnum(ViableAssignTargets)
  target: ViableAssignTargets;

  @IsNumber()
  id: number;
}

export class LinkToDto {
  @IsString()
  @IsEnum(ViableLinkTargets)
  target: ViableLinkTargets;

  @IsNumber()
  id: number;
}

export class CreateTaskDto {
  @Trim()
  @IsString()
  @Length(3, 255)
  label: string;

  // without a type the task gets the default one (DEFAULT_TASK_TYPE, see task_type/default-task-type.ts)
  @IsOptional()
  @IsNumber()
  type_id?: number;

  @IsObject()
  @ValidateNested()
  @TypeDecorator(() => AssignToDto)
  assign_to: AssignToDto;

  @IsObject()
  @ValidateNested()
  @TypeDecorator(() => LinkToDto)
  link_to: LinkToDto;

  @IsDateString()
  start_time: Date;

  @IsDateString()
  end_time: Date;

  @IsBoolean()
  allDay: boolean;

  /** The deadline is in the past on purpose (the task is already done, or a backdated one): see TASK_IN_PAST. */
  @IsOptional()
  @IsBoolean()
  allow_past?: boolean;

  /** Create it although the deal has an open task within ±15 minutes: see TASK_DUPLICATE. */
  @IsOptional()
  @IsBoolean()
  allow_duplicate?: boolean;
}

/**
 * PATCH /tasks/:id: only what is sent changes. A drag in the calendar or on the board sends the
 * times; the task keeps its type, assignee and links (a deal stays linked when the client sends
 * the company of that deal, as older clients do).
 */
export class UpdateTaskDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 255)
  label?: string;

  @IsOptional()
  @IsNumber()
  type_id?: number;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @TypeDecorator(() => AssignToDto)
  assign_to?: AssignToDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @TypeDecorator(() => LinkToDto)
  link_to?: LinkToDto;

  @IsOptional()
  @IsDateString()
  start_time?: Date;

  @IsOptional()
  @IsDateString()
  end_time?: Date;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  /** A new time in the past on purpose (TASK_IN_PAST). */
  @IsOptional()
  @IsBoolean()
  allow_past?: boolean;

  /** A new time or deal next to another open task of the deal on purpose (TASK_DUPLICATE). */
  @IsOptional()
  @IsBoolean()
  allow_duplicate?: boolean;
}
