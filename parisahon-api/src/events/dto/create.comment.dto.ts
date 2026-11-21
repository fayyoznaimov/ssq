import { IsString, Length } from 'class-validator';
import { Trim } from '../../helper/validators';

export class CreateCommentDto {
  @Trim()
  @IsString()
  @Length(2)
  comment: string;
}
