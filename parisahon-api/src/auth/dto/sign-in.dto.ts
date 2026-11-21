import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body of POST /auth/login.
 * (LoginUserDto is the shared base of the user create/update DTOs and makes
 * the password optional for ctr_agent, which is wrong for a login.)
 */
export class SignInDto {
  @IsString()
  @MaxLength(255)
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  password: string;
}
