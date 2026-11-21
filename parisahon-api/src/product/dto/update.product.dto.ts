import {
  IsArray,
  IsNumber,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProductFillerDto } from './create.product.dto';

export class UpdateProductFillerDto {
  @IsNumber()
  product_filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}

export class UpdateProductDto {
  @IsString()
  @Length(1, 255)
  name: string;

  @ValidateNested({ each: true })
  @Type(() => UpdateProductFillerDto)
  @IsArray()
  fillers: UpdateProductFillerDto[];

  @ValidateNested({ each: true })
  @Type(() => CreateProductFillerDto)
  @IsArray()
  fillers_create: CreateProductFillerDto[];
}
