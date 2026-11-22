import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSettingDto {
  @IsOptional()
  @IsNumber()
  default_stage_id: number;

  @IsOptional()
  @IsNumber()
  default_agent_id: number;

  // HTML with {{name}}, {{phone}}, {{email}}; empty string removes it
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  mail_signature: string;
}
