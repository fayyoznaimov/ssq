import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNumberString,
  IsOptional,
} from 'class-validator';

export enum TaskType {
  CLOSED = 'closed',
  OVERDUE = 'overdue',
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

  @IsOptional()
  @IsArray()
  assigned_to: number[];

  @IsOptional()
  @IsArray()
  created_by: number[];

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
