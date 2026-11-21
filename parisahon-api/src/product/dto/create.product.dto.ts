import {
  IsArray,
  IsNumber,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ChildFiller } from '../../filler/filler.entity';
import { Trim } from '../../helper/validators';

export class CreateProductFillerDto implements ChildFiller {
  @IsNumber()
  filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}

export class CreateProductDto {
  @Trim()
  @IsString()
  @Length(1, 255)
  name: string;

  @ValidateNested({ each: true })
  @Type(() => CreateProductFillerDto)
  @IsArray()
  fillers: CreateProductFillerDto[];
}
