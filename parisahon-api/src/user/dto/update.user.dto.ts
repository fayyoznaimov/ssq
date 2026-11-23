import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
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
import { Type } from 'class-transformer';
import { CreateUserFillerDto, EmptyToNull } from './create.user.dto';
import { IsPhoneLike, Trim } from '../../helper/validators';

export class UpdateUserFillerDto {
  @IsNumber()
  user_filler_id: number;

  // "" clears a value that is not required (the row is removed)
  @IsString()
  @Length(0, 255)
  value: string;
}

export class UpdateUserDto extends LoginUserDto {
  @IsString()
  @IsEnum(RoleEnum)
  role: RoleEnum;

  @Trim()
  @IsString()
  @Length(2, 255)
  username: string;

  // a contact's e-mail can be cleared ("" = none); staff accounts still need one (LoginUserDto)
  @EmptyToNull()
  email: string;

  @IsOptional()
  @IsNotEmpty()
  @Length(10, 255, { message: 'Пароль: от 10 символов' })
  password: string;

  @IsOptional()
  @IsNumber()
  tg_user_id: number;

  // not sent: unchanged; "" or null: cleared; otherwise stored normalized (helper/phone.ts)
  @EmptyToNull()
  @IsOptional()
  @IsString()
  @IsPhoneLike()
  @Length(3, 255)
  phone: string;

  @ValidateIf((o) => o.role !== RoleEnum.CTR_AGENT)
  @IsNumber()
  group_id: number;

  // a contact: not sent = the company stays, null = no company, a number = moved to that company
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
  @Type(() => UpdateUserFillerDto)
  @IsArray()
  fillers: UpdateUserFillerDto[];

  @ValidateIf((o) => o.role === RoleEnum.CTR_AGENT && o.fillers_create != null)
  @ValidateNested({ each: true })
  @Type(() => CreateUserFillerDto)
  @IsArray()
  fillers_create: CreateUserFillerDto[];
}

/**
 * Body of PATCH /users/me/password
 */
export class ChangeOwnPasswordDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 255)
  old_password: string;

  @IsString()
  @Length(10, 255, { message: 'Новый пароль: от 10 символов' })
  new_password: string;
}

/** Body of PATCH /users/me: what a staff user may change in their own card (name and phone). */
export class UpdateOwnProfileDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 255, { message: 'Имя: от 2 до 255 символов' })
  username?: string;

  // "" clears the phone
  @EmptyToNull()
  @IsOptional()
  @IsString()
  @IsPhoneLike()
  phone?: string | null;
}
