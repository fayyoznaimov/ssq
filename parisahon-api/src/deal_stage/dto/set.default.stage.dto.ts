import { IsInt, Min } from 'class-validator';

/** PATCH /stages/default */
export class SetDefaultStageDto {
  @IsInt()
  @Min(1)
  stage_id: number;
}
