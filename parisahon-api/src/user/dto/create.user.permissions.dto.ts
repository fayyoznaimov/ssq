import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { UserPermissions } from '../user.entity';
import { Type } from 'class-transformer';

export enum FullPermissionOptions {
  BANNED = 0,
  ALLOWED_IF_RESPONSIBLE = 1,
  ALLOWED_FOR_GROUP = 2,
  ALLOWED = 3,
}

export enum BasicPermissionOptions {
  BANNED = 0,
  ALLOWED = 3,
}

export class BasePermissionDto {
  @IsNumber()
  @IsEnum(FullPermissionOptions)
  update: number;

  @IsNumber()
  @IsEnum(FullPermissionOptions)
  delete: number;
}

export class FullPermissionDto extends BasePermissionDto {
  @IsNumber()
  @IsEnum(BasicPermissionOptions)
  create: number;

  @IsNumber()
  @IsEnum(FullPermissionOptions)
  view: number;

  @IsNumber()
  @IsEnum(FullPermissionOptions)
  export: number;
}

export class CreateUserPermissionsDto implements UserPermissions {
  @ValidateNested()
  @IsObject()
  @Type(() => FullPermissionDto)
  deal: FullPermissionDto;

  @ValidateNested()
  @IsObject()
  @Type(() => FullPermissionDto)
  contact: FullPermissionDto;

  @ValidateNested()
  @IsObject()
  @Type(() => FullPermissionDto)
  company: FullPermissionDto;

  @ValidateNested()
  @IsObject()
  @Type(() => BasePermissionDto)
  task: BasePermissionDto;

  @IsBoolean()
  mail: boolean;

  @IsBoolean()
  file: boolean;
}
