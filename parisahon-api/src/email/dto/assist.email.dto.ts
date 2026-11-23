import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** POST /emails/assist */
export class AssistEmailDto {
  @IsIn(['check', 'polite', 'shorter', 'english', 'russian', 'uzbek', 'draft', 'reply'])
  action: 'check' | 'polite' | 'shorter' | 'english' | 'russian' | 'uzbek' | 'draft' | 'reply';

  @IsOptional() @IsString() @MaxLength(255) subject?: string;

  @IsOptional() @IsString() @MaxLength(20000) body?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) deal_id?: number;

  /** the letter being answered (Mail): «Ответ клиенту» without a deal, and its text for «Проверить» */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) reply_to_email_id?: number;
}
