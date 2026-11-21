import { IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export type SortOptions = { [key: string]: string };

export const DEFAULT_PAGE_SIZE = 25;

/**
 * Upper bound for `limit`. The client loads dictionaries (users, groups,
 * collections) with limit=1000, so the cap must not be lower than that.
 */
export const MAX_PAGE_SIZE = 1000;

export class PaginationRequestDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;

  /**
   * sort[<column>]=1 (ASC) | -1 (DESC).
   * Column names are validated against the entity in HelperService.
   */
  @IsOptional()
  @IsObject()
  sort: SortOptions;
}

export class PaginationResponseDto<T> {
  data: T;
  count: number;
  page_size: number;
  current_page: number;
  last_page: number;
}
