import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsObject,
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
  @IsString()
  @Length(3, 255)
  label: string;

  @IsNumber()
  type_id: number;

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
}
