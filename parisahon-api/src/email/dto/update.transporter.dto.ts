import { IsEmail, IsOptional, IsString, Length } from 'class-validator';

export class UpdateTransporterDto {
  @IsString()
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @Length(3, 255)
  password: string;
}
