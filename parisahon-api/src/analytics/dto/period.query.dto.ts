import { IsDateString, IsOptional } from 'class-validator';

/**
 * An optional period of a report: plain dates (YYYY-MM-DD, both days included) or timestamps.
 * GET /analytics/calls (none: all time), GET /analytics/managers (none: the current month).
 */
export class PeriodQueryDto {
  @IsOptional()
  @IsDateString()
  from_date?: string;

  @IsOptional()
  @IsDateString()
  till_date?: string;
}
