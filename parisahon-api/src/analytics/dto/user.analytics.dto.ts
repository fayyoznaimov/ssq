import { IsDateString } from 'class-validator';

export class UserAnalyticsQuery {
  @IsDateString()
  from_date: Date;

  @IsDateString()
  till_date: Date;
}
