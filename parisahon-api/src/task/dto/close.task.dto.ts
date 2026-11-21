import { IsNotEmpty, IsString } from 'class-validator';

export class CloseTaskDto {
  @IsString()
  @IsNotEmpty()
  result: string;
}
