import { IsInt, IsOptional, IsString, Length } from 'class-validator';

export class StartSessionDto {
  @IsString()
  @Length(1, 16)
  code: string;

  // the cloud password of the account (two-step verification), asked for
  // when the first attempt answers needs_password
  @IsOptional()
  @IsString()
  @Length(1, 256)
  password?: string;

  @IsOptional()
  @IsInt()
  user_id?: number;
}
