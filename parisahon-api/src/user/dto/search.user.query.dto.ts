import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import { IsOptional, IsString } from 'class-validator';

export class SearchUserQueryDto extends PaginationRequestDto {
  @IsOptional()
  @IsString()
  username: string;

  @IsOptional()
  @IsString()
  role: string;
}
