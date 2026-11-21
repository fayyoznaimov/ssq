import { IsNumber, IsOptional } from 'class-validator';

export class UpdateSettingDto {
  @IsOptional()
  @IsNumber()
  default_stage_id: number;

  @IsOptional()
  @IsNumber()
  default_agent_id: number;
}
