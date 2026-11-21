import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class DeleteStageQueryDto {
  /**
   * Stage of the same collection that receives the deals and the stage
   * history of the stage being deleted.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  move_to?: number;
}
