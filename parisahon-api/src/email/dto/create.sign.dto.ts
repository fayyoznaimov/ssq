import { IsNumber, IsString } from 'class-validator';

export class CreateSignDto {
  @IsNumber()
  user_id: number;

  @IsString()
  sign: string;
}

export interface UserWithSign {
  user_id: number;
  sign: string;
  username: string;
}
