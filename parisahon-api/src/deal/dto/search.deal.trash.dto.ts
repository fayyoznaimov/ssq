import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';

/** GET /deals/trash */
export class SearchDealTrashDto extends PaginationRequestDto {
  /** Part of the name, or the deal number */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;
}
