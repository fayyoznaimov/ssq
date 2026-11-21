import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export class CreateDealStageDto {
  @IsString()
  @Length(3, 255)
  name: string;

  @IsOptional()
  @IsString()
  @Length(3, 1000)
  description: string;

  /**
   * Position of the stage inside its collection (smallint column).
   * Optional on create: a stage without order is appended to the end.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32000)
  order: number;

  @IsString()
  @Length(1, 255)
  color: string;

  @IsInt()
  collection_id: number;
}
