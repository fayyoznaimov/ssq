import { IsBooleanString, IsDateString, IsOptional } from 'class-validator';

export class DealAnalyticsQuery {
  @IsOptional()
  @IsBooleanString()
  is_active: string;

  // deals created in the period (plain dates, both days included); none: all deals
  @IsOptional()
  @IsDateString()
  from_date?: string;

  @IsOptional()
  @IsDateString()
  till_date?: string;
}
