import { TaskTypes } from '../../deal/dto/search.deal.dto';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import { RoleEnum } from 'src/user/user.entity';

export class SearchContactDto extends PaginationRequestDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  phone: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  email: string;

  @IsOptional()
  @IsEnum(RoleEnum)
  role: RoleEnum;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  name: string;

  // one search box: the name, the e-mail or the phone (any format)
  @IsOptional()
  @IsString()
  @Length(1, 255)
  q?: string;

  @IsOptional()
  @IsString()
  employees: string;

  @IsOptional()
  @IsDateString()
  created_after: Date;

  @IsOptional()
  @IsDateString()
  created_before: Date;

  @IsOptional()
  @IsDateString()
  updated_after: Date;

  @IsOptional()
  @IsDateString()
  updated_before: Date;

  @IsOptional()
  @IsArray()
  @IsNumberString(undefined, { each: true })
  stages: number[];

  @IsOptional()
  @IsNumberString()
  created_by: number;

  @IsOptional()
  @IsNumberString()
  updated_by: number;

  @IsOptional()
  @IsEnum(TaskTypes, { each: true })
  tasks: TaskTypes[];
}
