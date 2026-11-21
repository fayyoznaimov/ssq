import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional, IsPhoneNumber,
  IsString,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { RoleEnum } from '../user.entity';
import { LoginUserDto } from '../../auth/dto/login.user.dto';
import { CreateUserPermissionsDto } from './create.user.permissions.dto';
import { Type } from 'class-transformer';
import { CreateUserFillerDto } from './create.user.dto';
import { Trim } from '../../helper/validators';

export class UpdateUserFillerDto {
  @IsNumber()
  user_filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}

export class UpdateUserDto extends LoginUserDto {
  @IsString()
  @IsEnum(RoleEnum)
  role: RoleEnum;

  @Trim()
  @IsString()
  @Length(3, 255)
  username: string;

  @IsOptional()
  @IsNotEmpty()
  @Length(3, 255)
  password: string;

  @IsOptional()
  @IsNumber()
  tg_user_id: number;

  @IsOptional()
  @IsString()
  @IsPhoneNumber()
  @Length(3, 255)
  phone: string;

  @ValidateIf((o) => o.role !== RoleEnum.CTR_AGENT)
  @IsNumber()
  group_id: number;

  @ValidateIf((o) => o.role === RoleEnum.CTR_AGENT)
  @IsNumber()
  company_id: number;

  @ValidateIf((o) => ![RoleEnum.ADMIN, RoleEnum.CTR_AGENT].includes(o.role))
  @IsObject()
  @ValidateNested()
  @Type(() => CreateUserPermissionsDto)
  permissions: CreateUserPermissionsDto;

  @ValidateIf((o) => o.role === RoleEnum.CTR_AGENT)
  @ValidateNested({ each: true })
  @Type(() => UpdateUserFillerDto)
  @IsArray()
  fillers: UpdateUserFillerDto[];

  @ValidateIf((o) => o.role === RoleEnum.CTR_AGENT)
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
  @Length(8, 255)
  new_password: string;
}
