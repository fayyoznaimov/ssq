import { IsNumber } from 'class-validator';

export class RemapEventDto {
  @IsNumber()
  event_id: number;

  @IsNumber()
  replace_with_deal_id: number;
}
