import { IsEmail, IsString, Length } from 'class-validator';

export class CreateTransporterDto {
  @IsString()
  @IsEmail()
  email: string;

  @IsString()
  @Length(3, 255)
  password: string;
}
