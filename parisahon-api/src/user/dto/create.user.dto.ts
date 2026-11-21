import {
  IsArray,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { RoleEnum } from '../user.entity';
import { LoginUserDto } from '../../auth/dto/login.user.dto';
import { CreateUserPermissionsDto } from './create.user.permissions.dto';
import { Type } from 'class-transformer';
import { ChildFiller } from '../../filler/filler.entity';

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

  @IsString()
  @Length(3, 255)
  username: string;

  @IsOptional()
  @IsString()
  @IsPhoneNumber()
  @Length(3, 255)
  phone: string;

  @IsOptional()
  @IsNumber()
  tg_user_id: number;

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
  @Type(() => CreateUserFillerDto)
  @IsArray()
  fillers: CreateUserFillerDto[];
}
