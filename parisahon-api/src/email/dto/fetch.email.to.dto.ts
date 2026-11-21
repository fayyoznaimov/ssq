import { IsOptional, IsString } from 'class-validator';
import { PaginationRequestDto } from 'src/helper/dto/pagination.dto';

export class FetchEmailToDto extends PaginationRequestDto {
  @IsString()
  @IsOptional()
  search: string;
}
