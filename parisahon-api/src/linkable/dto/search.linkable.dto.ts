import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import { IsString, Length } from 'class-validator';

export class SearchLinkableDto extends PaginationRequestDto {
  @IsString()
  @Length(1, 255)
  name: string;
}
