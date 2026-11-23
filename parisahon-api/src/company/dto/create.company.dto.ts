import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CompanyRequisitesDto } from './company.requisites.dto';
import { ChildFiller } from '../../filler/filler.entity';
import { EmptyToUndefined, IsPhoneLike, Trim } from '../../helper/validators';

export class CreateCompanyFillerDto implements ChildFiller {
  @IsNumber()
  filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}
/**
 * A contact created together with its company. Before, `users` was typed as the User entity,
 * which has no validation decorators: an empty name, the e-mail "bad" and the phone "abc" went in.
 * Fields this class does not list (fillers, avatar ...) still pass: `whitelist` is off.
 */
export class CompanyContactDto {
  @Trim()
  @IsString()
  @Length(2, 255)
  username: string;

  @EmptyToUndefined()
  @IsOptional()
  @IsEmail()
  @Length(3, 255)
  email?: string;

  @EmptyToUndefined()
  @IsOptional()
  @IsString()
  @IsPhoneLike()
  phone?: string;

  [key: string]: any;
}

export class CreateCompanyDto extends CompanyRequisitesDto {
  @Trim()
  @IsString()
  @Length(3, 255)
  name: string;

  @IsBoolean()
  is_old: boolean;

  // "" from the form: no e-mail (it failed @IsEmail)
  @EmptyToUndefined()
  @IsOptional()
  @IsString()
  @IsEmail()
  @Length(3, 255)
  email: string;

  @EmptyToUndefined()
  @IsOptional()
  @IsString()
  @IsPhoneLike()
  @Length(3, 255)
  phone: string;

  @ValidateNested({ each: true })
  @Type(() => CreateCompanyFillerDto)
  @IsArray()
  fillers: CreateCompanyFillerDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CompanyContactDto)
  @IsArray()
  users: CompanyContactDto[];
}
