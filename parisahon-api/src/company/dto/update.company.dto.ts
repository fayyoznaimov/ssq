import {
  IsInt,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { CreateCompanyFillerDto } from './create.company.dto';
import { Type } from 'class-transformer';
import { CompanyRequisitesDto } from './company.requisites.dto';
import { UpdateUserDto } from 'src/user/dto/update.user.dto';
import { EmptyToUndefined, IsPhoneLike, Trim } from '../../helper/validators';

export class UpdateCompanyFillerDto {
  @IsNumber()
  company_filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}

export class UpdateCompanyDto {
  @Trim()
  @IsString()
  @Length(3, 255)
  name: string;

  @IsOptional()
  @IsString()
  @IsEmail()
  @Length(3, 255)
  email: string;

  @IsOptional()
  @IsBoolean()
  is_old: boolean;

  @EmptyToUndefined()
  @IsOptional()
  @IsString()
  @IsPhoneLike()
  @Length(3, 255)
  phone: string;

  @ValidateNested({ each: true })
  @Type(() => UpdateCompanyFillerDto)
  @IsArray()
  fillers: UpdateCompanyFillerDto[];

  @ValidateNested({ each: true })
  @Type(() => UpdateUserDto)
  @IsArray()
  users: (UpdateUserDto & { id: number })[];

  @ValidateNested({ each: true })
  @Type(() => CreateCompanyFillerDto)
  @IsArray()
  fillers_create: CreateCompanyFillerDto[];
}

export class FlatCompanyFillerDto {
  @IsNumber()
  id: number;

  @IsString()
  value: string;
}

export class FlatUserFillerDto {
  @IsNumber()
  id: number;

  @IsString()
  value: string;
}

export class FlatUserDto {
  @IsString()
  username: string;

  @IsString()
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @ValidateNested({ each: true })
  @Type(() => FlatUserFillerDto)
  @IsArray()
  fillers: FlatUserFillerDto[];
}

export class CreateCompanyFlatDto extends CompanyRequisitesDto {
  @IsString()
  @Length(3, 255)
  name: string;

  @IsOptional()
  @IsString()
  @Length(3, 255)
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsBoolean()
  is_old?: boolean;

  @IsOptional()
  @IsString()
  @Length(3, 255)
  phone?: string;

  @ValidateNested({ each: true })
  @Type(() => FlatCompanyFillerDto)
  @IsArray()
  fillers: FlatCompanyFillerDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FlatUserDto)
  @IsArray()
  users: (FlatUserDto & { id: number })[];

  // one of the company's contacts; null = none (a single contact is the primary one anyway)
  @IsOptional()
  @IsInt()
  primary_contact_id?: number | null;
}
