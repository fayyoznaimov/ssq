import { IsBooleanString, IsDateString, IsOptional } from 'class-validator';

export class DesktopQueryDto {
  @IsDateString()
  from_date: Date;

  /** A plain date counts in full: from_date=till_date=today is "Сегодня". */
  @IsDateString()
  till_date: Date;

  /** true: the caller's own numbers (any staff user); otherwise company-wide (admin and manager). */
  @IsOptional()
  @IsBooleanString()
  my_stats: string;

  /** The staff users picked on the desktop (user_ids[]=1&user_ids[]=2): only their numbers. */
  @IsOptional()
  user_ids: number[] | number | string | string[];
}
