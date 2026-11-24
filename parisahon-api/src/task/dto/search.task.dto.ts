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
  /** open, the deadline not passed yet: «Задачи к выполнению» of the desktop */
  UPCOMING = 'upcoming',
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

  /** Closed on or after this day (the desktop's «Выполненные задачи» of a period). */
  @IsOptional()
  @IsDateString()
  closed_from: string;

  /** Closed on or before this day (a plain date counts in full). */
  @IsOptional()
  @IsDateString()
  closed_till: string;

  /** Created on or after this moment (the list's «Создана» filter; from_date / till_date go by the deadline). */
  @IsOptional()
  @IsDateString()
  created_from: string;

  /** Created on or before this moment (a plain date counts in full). */
  @IsOptional()
  @IsDateString()
  created_till: string;
}
