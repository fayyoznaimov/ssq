import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CompanyRequisitesDto } from './company.requisites.dto';
import { ChildFiller } from '../../filler/filler.entity';
import { User } from 'src/user/user.entity';

export class CreateCompanyFillerDto implements ChildFiller {
  @IsNumber()
  filler_id: number;

  @IsString()
  @Length(1, 255)
  value: string;
}
export class CreateCompanyDto extends CompanyRequisitesDto {
  @IsString()
  @Length(3, 255)
  name: string;

  @IsBoolean()
  is_old: boolean;

  @IsOptional()
  @IsString()
  @IsEmail()
  @Length(3, 255)
  email: string;

  @IsOptional()
  @IsString()
  @Length(3, 255)
  phone: string;

  @ValidateNested({ each: true })
  @Type(() => CreateCompanyFillerDto)
  @IsArray()
  fillers: CreateCompanyFillerDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => User)
  @IsArray()
  users: User[];
}
