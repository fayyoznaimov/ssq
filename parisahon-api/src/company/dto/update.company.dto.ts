import {
  IsInt,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CreateCompanyFillerDto } from './create.company.dto';
import { Transform, Type } from 'class-transformer';
import { CompanyRequisitesDto } from './company.requisites.dto';
import { UpdateUserDto } from 'src/user/dto/update.user.dto';
import { EmptyToNull } from 'src/user/dto/create.user.dto';
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

/**
 * A custom field value in PATCH /companies/:id, in any of the formats the clients send:
 * {id, value} — the id of the company's value (the company card); {company_filler_id, value} — the
 * same, from the deal form (it was refused with 'fillers.0.id must be a number'); {filler_id, value} —
 * the field itself (set, or created when the company has no value yet). "" clears a value.
 */
export class FlatCompanyFillerDto {
  @ValidateIf((o) => o.filler_id == null && o.company_filler_id == null)
  @IsNumber()
  id?: number;

  @IsOptional()
  @IsNumber()
  company_filler_id?: number;

  @IsOptional()
  @IsNumber()
  filler_id?: number;

  @IsString()
  @Length(0, 255)
  value: string;
}

/** A custom field of a contact in the company card: {filler_id, value} (the field) or {id, value} (the contact's value). */
export class FlatUserFillerDto {
  @ValidateIf((o) => o.filler_id == null)
  @IsNumber()
  id?: number;

  @IsOptional()
  @IsNumber()
  filler_id?: number;

  @IsString()
  @Length(0, 255)
  value: string;
}

/**
 * A contact in the company card. With an id: a contact of this company that is changed; without: a
 * new contact. The e-mail is optional ("" = none): contacts from the bot and business cards often
 * have none, and such a company could not be saved at all.
 */
export class FlatUserDto {
  @IsOptional()
  @IsInt()
  id?: number;

  @Trim()
  @IsString()
  @Length(2, 255)
  username: string;

  @EmptyToNull()
  @IsOptional()
  @IsString()
  @IsEmail()
  email?: string | null;

  @EmptyToNull()
  @IsOptional()
  @IsString()
  @IsPhoneLike()
  phone?: string | null;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FlatUserFillerDto)
  @IsArray()
  fillers: FlatUserFillerDto[];
}

/** "" from a form, for the fields that may be cleared: null (cleared). */
const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

/**
 * PATCH /companies/:id. Every field is optional: only what is sent changes (the deal form re-sent the
 * whole company and reset «Старый клиент»).
 */
export class CreateCompanyFlatDto extends CompanyRequisitesDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 255)
  name?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @Length(3, 255)
  @IsEmail()
  email?: string | null;

  @IsOptional()
  @IsBoolean()
  is_old?: boolean;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @IsPhoneLike()
  @Length(3, 255)
  phone?: string | null;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FlatCompanyFillerDto)
  @IsArray()
  fillers?: FlatCompanyFillerDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateCompanyFillerDto)
  @IsArray()
  fillers_create?: CreateCompanyFillerDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FlatUserDto)
  @IsArray()
  users?: FlatUserDto[];

  // contacts detached from the company (they stay in the CRM): the trash button of the card
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  removed_user_ids?: number[];

  // one of the company's contacts; null = none (a single contact is the primary one anyway)
  @IsOptional()
  @IsInt()
  primary_contact_id?: number | null;
}
