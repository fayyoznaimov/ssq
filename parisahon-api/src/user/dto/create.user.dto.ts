import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { RoleEnum } from '../user.entity';
import { LoginUserDto } from '../../auth/dto/login.user.dto';
import { CreateUserPermissionsDto } from './create.user.permissions.dto';
import { Transform, Type } from 'class-transformer';
import { ChildFiller } from '../../filler/filler.entity';
import { IsPhoneLike, Trim } from '../../helper/validators';

/**
 * "" from a form is "no value": a contact (ctr_agent) may have no e-mail and no phone (Telegram,
 * WhatsApp, calls create them so), and "" must not reach @IsEmail / @IsPhoneLike.
 */
export function EmptyToNull(): PropertyDecorator {
  return Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });
}

export class CreateUserFillerDto implements ChildFiller {
  @IsNumber()
  filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}

export class CreateUserDto extends LoginUserDto {
  @IsString()
  @IsEnum(RoleEnum)
  role: RoleEnum;

  @Trim()
  @IsString({ message: 'Имя: текст' })
  @Length(2, 255, { message: 'Имя: от 2 до 255 символов' })
  username: string;

  // a contact needs no e-mail ("" = none); staff accounts still need one to log in (LoginUserDto)
  @EmptyToNull()
  email: string;

  // one rule for every phone: as people type it, stored normalized (helper/phone.ts)
  @EmptyToNull()
  @IsOptional()
  @IsString()
  @IsPhoneLike()
  @Length(3, 255)
  phone: string;

  @IsOptional()
  @IsNumber()
  tg_user_id: number;

  @ValidateIf((o) => o.role !== RoleEnum.CTR_AGENT)
  @IsNumber()
  group_id: number;

  // a contact may have no company: Telegram, WhatsApp and calls create them without one
  @ValidateIf((o) => o.role === RoleEnum.CTR_AGENT && o.company_id != null)
  @IsInt()
  company_id: number | null;

  @ValidateIf((o) => ![RoleEnum.ADMIN, RoleEnum.CTR_AGENT].includes(o.role))
  @IsObject()
  @ValidateNested()
  @Type(() => CreateUserPermissionsDto)
  permissions: CreateUserPermissionsDto;

  @ValidateIf((o) => o.role === RoleEnum.CTR_AGENT && o.fillers != null)
  @ValidateNested({ each: true })
  @Type(() => CreateUserFillerDto)
  @IsArray()
  fillers: CreateUserFillerDto[];
}
