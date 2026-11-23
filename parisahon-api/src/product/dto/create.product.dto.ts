import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ChildFiller } from '../../filler/filler.entity';
import { Trim } from '../../helper/validators';

export class CreateProductFillerDto implements ChildFiller {
  @IsNumber()
  filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}

/** "" from a form is "no value". */
export const EmptyToNullValue = () =>
  Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value));

/** A price typed as "12 500,50" or 12500.5: a number with at most 2 decimals; "" is no price. */
export const PriceValue = () =>
  Transform(({ value }) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'number') return value;
    const text = String(value).replace(/\s/g, '').replace(',', '.');
    if (text === '') return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : value;
  });

/** The catalogue fields of a product (create and update). */
export class ProductCatalogueDto {
  @IsOptional()
  @EmptyToNullValue()
  @IsString()
  @Length(1, 64)
  sku?: string | null;

  @IsOptional()
  @EmptyToNullValue()
  @IsString()
  @Length(1, 32)
  unit?: string | null;

  @IsOptional()
  @PriceValue()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Цена: число, не больше 2 знаков после запятой' })
  @Min(0)
  @Max(999999999999)
  price?: number | null;
}

export class CreateProductDto extends ProductCatalogueDto {
  @Trim()
  @IsString()
  @Length(1, 255)
  name: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateProductFillerDto)
  @IsArray()
  fillers: CreateProductFillerDto[];
}
