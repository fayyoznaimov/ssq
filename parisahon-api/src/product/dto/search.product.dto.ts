import { IsDateString, IsOptional, IsString, Length } from 'class-validator';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';

export class SearchProductDto extends PaginationRequestDto {
  // a part of the name or of the article (артикул)
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name: string;

  // «Дата создания» of the list: from / till (whole days)
  @IsOptional()
  @IsDateString()
  created_from?: string;

  @IsOptional()
  @IsDateString()
  created_till?: string;
}
