import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import { WhichFiles } from '../../trigger/dto/assign.trigger.dto';

export class SearchFileDto extends PaginationRequestDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name: string;

  /** with_extensions[]=.png&with_extensions[]=jpg, or one value "png jpg" */
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  @IsString({ each: true })
  @Length(1, 255, { each: true })
  with_extensions: string[];

  @IsOptional()
  @IsDateString()
  created_at_from: Date;

  @IsOptional()
  @IsDateString()
  created_at_till: Date;

  @IsOptional()
  @IsNumberString()
  uploaded_by: number;

  @IsOptional()
  @IsNumberString()
  from_bytes: number;

  @IsOptional()
  @IsNumberString()
  till_bytes: number;

  @IsOptional()
  @IsEnum(WhichFiles)
  uploaded_from: WhichFiles;
}
