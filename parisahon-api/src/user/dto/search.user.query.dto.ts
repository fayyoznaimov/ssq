import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import { IsBooleanString, IsOptional, IsString, MaxLength } from 'class-validator';

export class SearchUserQueryDto extends PaginationRequestDto {
  @IsOptional()
  @IsString()
  username: string;

  @IsOptional()
  @IsString()
  role: string;

  // staff=true: staff accounts only (admin, manager, agent), no contacts
  @IsOptional()
  @IsBooleanString()
  staff?: string;
}

/** GET /users/staff: every staff account for the pickers and filters, sorted by name, without a page limit. */
export class StaffQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  // with_deleted=true: removed employees too (marked by deleted_at), for the filters of old deals and tasks
  @IsOptional()
  @IsBooleanString()
  with_deleted?: string;
}
