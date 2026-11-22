import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

/** GET /analytics/control */
export class ControlQueryDto {
  // plain dates (YYYY-MM-DD) or timestamps; default: the current month
  @IsOptional()
  @IsDateString()
  from_date?: string;

  @IsOptional()
  @IsDateString()
  till_date?: string;

  // the answer norm in working minutes
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  sla_minutes?: number;

  // "waiting now": unanswered for at least this many working hours
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  waiting_hours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  agent_id?: number;
}
