import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Objective } from 'src/user/dto/objective.dto';

export class UserObjectivesDto {
  @IsNumber()
  id: number;

  @IsObject()
  @ValidateNested()
  @Type(() => Objective)
  objectives: Objective;
}

export class GroupObjectiveDto {
  @IsNumber()
  id: number;

  @IsObject()
  @ValidateNested()
  @Type(() => Objective)
  objectives: Objective;

  @ValidateNested({ each: true })
  @Type(() => UserObjectivesDto)
  @IsArray()
  users: UserObjectivesDto[];
}

export class UpsertObjectivesDto {
  @ValidateNested({ each: true })
  @Type(() => GroupObjectiveDto)
  @IsArray()
  data: GroupObjectiveDto[];
}
