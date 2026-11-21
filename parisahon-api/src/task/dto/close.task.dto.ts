import { IsNotEmpty, IsString } from 'class-validator';
import { Trim } from '../../helper/validators';

export class CloseTaskDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  result: string;
}
