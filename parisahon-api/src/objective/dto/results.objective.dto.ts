import { IsDateString } from 'class-validator';

export class ResultsObjectiveQuery {
  @IsDateString()
  from_date: Date;

  @IsDateString()
  till_date: Date;
}
