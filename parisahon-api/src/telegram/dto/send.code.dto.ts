import { IsInt, IsOptional } from 'class-validator';

export class SendCodeDto {
  // whose Telegram account to connect; defaults to the requester, another
  // user's account only for an admin
  @IsOptional()
  @IsInt()
  user_id?: number;
}
