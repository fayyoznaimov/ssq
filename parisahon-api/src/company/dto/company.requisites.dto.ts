import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/** Empty strings from the form are stored as NULL. */
const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

/**
 * Optional company requisites, shared by create and update.
 * Values are kept as text: formats differ between countries (ИНН 9/10/12
 * digits, МФО 5 digits, БИК 9 digits), the recognition step only warns about
 * suspicious values instead of rejecting them.
 */
export class CompanyRequisitesDto {
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  inn?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  legal_address?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(34)
  bank_account?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(255)
  bank_name?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  mfo?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  oked?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(255)
  director?: string | null;
}

export const COMPANY_REQUISITE_FIELDS = [
  'inn',
  'legal_address',
  'bank_account',
  'bank_name',
  'mfo',
  'oked',
  'director',
] as const;
