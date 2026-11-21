import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateDealFillerDto, LinkProductsDto } from './create.deal.dto';

export class UpdateDealFillerDto {
  @IsNumber()
  deal_filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}

/**
 * PATCH /deals/:id
 *
 * Every field is optional: a field that is not sent is left untouched.
 * (The edit form sends all of them, bulk actions send only what they change.)
 *
 * `products`, when sent, is the complete list of products of the deal:
 * products missing from the list are removed from the deal.
 */
export class UpdateDealDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  label?: string;

  @IsOptional()
  @IsNumber()
  budget?: number;

  @IsOptional()
  @IsInt()
  agent_id?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  ctr_agent_ids?: number[];

  @IsOptional()
  @IsInt()
  company_id?: number;

  /**
   * Changing the stage here goes through the same code as
   * PATCH /deals/:id/stage (stage history, events, triggers).
   */
  @IsOptional()
  @IsInt()
  deal_stage_id?: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => UpdateDealFillerDto)
  @IsArray()
  fillers?: UpdateDealFillerDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateDealFillerDto)
  @IsArray()
  fillers_create?: CreateDealFillerDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => LinkProductsDto)
  @IsArray()
  products?: LinkProductsDto[];
}

export class UpdateStageOfDeal {
  @IsInt()
  stage_id: number;
}
