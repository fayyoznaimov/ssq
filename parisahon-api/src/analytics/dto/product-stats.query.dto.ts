import { IsDateString, IsOptional } from 'class-validator';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';

/**
 * GET /products/statistics («Аналитика → По товарам»): a page of products with an optional period —
 * the products of the deals created in it (plain dates, both days included), as «Анализ продаж» counts.
 */
export class ProductStatsQueryDto extends PaginationRequestDto {
  @IsOptional()
  @IsDateString()
  from_date?: string;

  @IsOptional()
  @IsDateString()
  till_date?: string;
}
