import { IsDateString, IsEnum } from 'class-validator';

export enum PeriodEnum {
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
}

export class ConsolidatedReportQuery {
  @IsDateString()
  from_date: Date;

  @IsDateString()
  till_date: Date;

  @IsEnum(PeriodEnum)
  period: PeriodEnum;
}
