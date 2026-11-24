import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import {
  IsArray,
  IsBooleanString,
  IsDateString,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class SearchEmailDto extends PaginationRequestDto {
  @IsOptional()
  @IsString()
  @Length(2, 255)
  from: string;

  @IsOptional()
  @IsString()
  subject: string;

  @IsOptional()
  @IsString()
  deal_label: string;

  @IsOptional()
  @IsBooleanString()
  outgoing: string;

  @IsOptional()
  @IsDateString()
  from_date: string;

  @IsOptional()
  @IsDateString()
  till_date: string;

  @IsOptional()
  @IsArray()
  @IsNumberString(undefined, { each: true })
  stages: number[];

  @IsOptional()
  @IsBooleanString()
  read: string;

  @IsOptional()
  @IsBooleanString()
  with_deal: string;

  @IsOptional()
  @IsBooleanString()
  with_attachments: string;

  @IsOptional()
  @IsBooleanString()
  is_spam: string;

  /** "true": the letters deleted in the CRM and those in the Trash mailbox («Удалённые») */
  @IsOptional()
  @IsBooleanString()
  deleted: string;

  @IsOptional()
  @IsString()
  email_to: string;

  /** "true": letters of clients (in a deal, from a contact or a company address); "false": «Неразобранные» */
  @IsOptional()
  @IsBooleanString()
  of_client: string;
}
