import { IsNumberString, IsOptional } from 'class-validator';

export class FetchQueryDto {
  @IsOptional()
  @IsNumberString()
  collection_id: string;
}
