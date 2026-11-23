import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import {
  IsArray,
  IsBooleanString,
  IsDateString,
  IsEnum,
  IsNumberString,
  IsOptional,
} from 'class-validator';

/** Status filter of GET /tasks. Without it: open tasks (what the deal page and older clients expect). */
export enum TaskType {
  OPEN = 'open',
  CLOSED = 'closed',
  OVERDUE = 'overdue',
  ALL = 'all',
}

export default class SearchTaskDto extends PaginationRequestDto {
  @IsOptional()
  @IsNumberString()
  type_id: number;

  @IsOptional()
  @IsArray()
  stage_ids: number[];

  @IsOptional()
  @IsNumberString()
  deal_id: number;

  /** Tasks of a client company: linked to it, to one of its deals or to one of its contacts. */
  @IsOptional()
  @IsNumberString()
  company_id: number;

  /** Tasks of a contact: linked to the contact or to a deal of the contact. */
  @IsOptional()
  @IsNumberString()
  ctr_agent_id: number;

  @IsOptional()
  @IsArray()
  assigned_to: number[];

  @IsOptional()
  @IsArray()
  created_by: number[];

  /** "Мои": assigned to the current user or to the current user's group. */
  @IsOptional()
  @IsBooleanString()
  mine: string;

  @IsOptional()
  @IsEnum(TaskType)
  type: TaskType;

  @IsOptional()
  @IsDateString()
  from_date: Date;

  @IsOptional()
  @IsDateString()
  till_date: Date;
}
