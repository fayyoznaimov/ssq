import { IsString, Length } from 'class-validator';

export default class CreateTaskTypeDto {
  @IsString()
  @Length(2, 255)
  name: string;
}
