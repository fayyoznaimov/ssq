import { IsBooleanString, IsDateString } from 'class-validator';

export class DesktopQueryDto {
  @IsDateString()
  from_date: Date;

  @IsDateString()
  till_date: Date;

  @IsBooleanString()
  my_stats: string;
}
