import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { FillableTablesEnum } from '../filler.entity';

export class UpdateFillerDto {
  @IsString()
  @IsEnum(FillableTablesEnum)
  @Length(3, 255)
  target: string;

  @IsString()
  @Length(3, 255)
  field: string;

  @IsOptional()
  @IsBoolean()
  is_required: boolean;
}
