import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** GET /companies/similar: what the user is typing in a company or contact form. */
export class SimilarQueryDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(64) phone?: string;
  @IsOptional() @IsString() @MaxLength(255) email?: string;
  @IsOptional() @IsString() @MaxLength(64) inn?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) exclude_company_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) exclude_contact_id?: number;
}
