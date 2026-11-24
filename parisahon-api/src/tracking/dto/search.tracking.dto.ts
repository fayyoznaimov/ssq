import {
  IsDateString,
  IsEnum,
  IsNumberString,
  IsOptional,
} from 'class-validator';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import { FieldsOf } from '../../events/event.entity';

export class SearchTrackingDto extends PaginationRequestDto {
  @IsOptional()
  @IsNumberString(undefined, { each: true })
  types: number[];

  // a date (the last day of the period, inclusive) or a moment
  @IsOptional()
  @IsDateString()
  created_before: Date;

  @IsOptional()
  @IsDateString()
  created_after: Date;

  @IsOptional()
  @IsNumberString()
  originated_by: number;

  @IsOptional()
  @IsEnum(FieldsOf, { each: true })
  entities: FieldsOf[];

  // the history of one deal
  @IsOptional()
  @IsNumberString()
  deal_id: number;

  // what is about one client: a company, a contact (event.company_id / contact_id, DB-9)
  @IsOptional()
  @IsNumberString()
  company_id: number;

  @IsOptional()
  @IsNumberString()
  contact_id: number;
}
