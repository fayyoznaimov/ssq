import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProductFillerDto, ProductCatalogueDto } from './create.product.dto';
import { Trim } from '../../helper/validators';

export class UpdateProductFillerDto {
  @IsNumber()
  product_filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}

export class UpdateProductDto extends ProductCatalogueDto {
  @Trim()
  @IsString()
  @Length(1, 255)
  name: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => UpdateProductFillerDto)
  @IsArray()
  fillers: UpdateProductFillerDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateProductFillerDto)
  @IsArray()
  fillers_create: CreateProductFillerDto[];
}
