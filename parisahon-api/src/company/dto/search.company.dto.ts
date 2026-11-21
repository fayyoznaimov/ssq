import {
  IsBooleanString,
  IsDateString, IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';

export interface RawCompanyResult {
  t0_id: number;
  t0_name: string;
  t0_email: string;
  t0_is_old: boolean;
  t0_phone: string;
  t0_updated_at: string;
  t0_deleted_at: string;
  t0_created_at: string;
  total_count: number;
  min_created_at: string;
  deal_count: number;
  live_time_value: number;
  deal_count_this_period: number;
  deal_count_previous_period: number;
}

export enum CompareDealCountPeriod {
  MONTH = 'month',
  QUARTER = 'quarter',
  YEAR = 'year',
}

export class SearchCompanyDto extends PaginationRequestDto {
  @IsOptional()
  @IsString()
  name: string;

  @IsOptional()
  @IsDateString()
  with_deals_at_period_start: Date;

  @IsOptional()
  @IsDateString()
  with_deals_at_period_end: Date;

  @IsOptional()
  @IsBooleanString()
  is_old: string;

  @IsOptional()
  @IsBooleanString()
  had_deals_before: string;

  @IsOptional()
  @IsEnum(CompareDealCountPeriod)
  compare_deal_count_period: CompareDealCountPeriod;
}
