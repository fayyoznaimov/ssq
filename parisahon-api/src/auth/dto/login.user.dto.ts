import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';
import { RoleEnum } from '../../user/user.entity';

export class LoginUserDto {
  // A customer contact (ctr_agent) may have no email: many come from a
  // business card or a Telegram chat. Everyone else needs it to log in.
  @ValidateIf((o) => o.role !== RoleEnum.CTR_AGENT || o.email != null)
  @IsString()
  @Length(3, 255)
  @IsEmail()
  email: string;

  @ValidateIf((o) => o.role !== RoleEnum.CTR_AGENT)
  @IsNotEmpty()
  @Length(10, 255, { message: 'Пароль: от 10 символов' })
  password: string;
}
