import { IsBooleanString, IsOptional } from 'class-validator';

export class DealAnalyticsQuery {
  @IsOptional()
  @IsBooleanString()
  is_active: string;
}
