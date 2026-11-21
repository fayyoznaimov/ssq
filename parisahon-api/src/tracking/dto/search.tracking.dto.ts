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
}
