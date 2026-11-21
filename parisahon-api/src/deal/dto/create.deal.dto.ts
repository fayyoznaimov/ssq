import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ChildFiller } from '../../filler/filler.entity';
import { Type } from 'class-transformer';
import { EmptyToUndefined, IsPhoneLike, Trim } from '../../helper/validators';

export class CreateDealFillerDto implements ChildFiller {
  @IsNumber()
  filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}

export class LinkProductsDto {
  @IsNumber()
  product_id: number;

  @IsNumber()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  quantity: number;

  @IsNumber()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  price: number;
}

export class CreateDealDto {
  // empty is allowed: a deal made from a letter is named by its number
  @Trim()
  @IsString()
  @Length(0, 255)
  label: string;

  // a whole amount: the column is bigint
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  budget: number;

  /** A number of one's own; without it the deal gets the next one (max + 1) */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  display_id: number;

  @IsOptional()
  @IsNumber()
  stage_id: number;

  @IsNumber()
  agent_id: number;

  @IsArray()
  @IsInt({ each: true })
  ctr_agent_ids: number[];

  // Optional: deals created from mail / telegram have no company yet
  @IsOptional()
  @IsInt()
  company_id: number;

  @ValidateNested({ each: true })
  @Type(() => CreateDealFillerDto)
  @IsArray()
  fillers: CreateDealFillerDto[];

  @ValidateNested({ each: true })
  @Type(() => LinkProductsDto)
  @IsArray()
  products: LinkProductsDto[];
}
