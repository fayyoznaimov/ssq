import { IsOptional, IsString, Length } from 'class-validator';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';

export class SearchProductDto extends PaginationRequestDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name: string;
}
