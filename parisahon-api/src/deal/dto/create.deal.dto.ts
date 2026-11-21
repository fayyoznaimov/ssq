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
  quantity: number;

  @IsNumber()
  price: number;
}

export class CreateDealDto {
  @IsString()
  label: string;

  @IsNumber()
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
