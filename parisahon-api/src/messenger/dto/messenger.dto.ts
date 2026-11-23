import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/** POST /messenger/ignored — «Не клиент»: from a contact (in a deal: the deal's manager's list) or a phone. */
export class AddIgnoredChatDto {
  @IsOptional()
  @IsInt()
  contact_id?: number;

  @IsOptional()
  @IsInt()
  deal_id?: number;

  // whose list (admin only; default: the requester, in a deal: the deal's manager)
  @IsOptional()
  @IsInt()
  user_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  // only this messenger; default both
  @IsOptional()
  @IsIn(['telegram', 'whatsapp'])
  channel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;
}

/** PATCH /messenger/settings — «только известные контакты» of a manager (null = as set on the server). */
export class MessengerSettingsDto {
  @IsOptional()
  @IsInt()
  user_id?: number;

  @IsOptional()
  @IsIn(['telegram', 'whatsapp'])
  channel?: string;

  @ValidateIf((o) => o.known_only !== null)
  @IsBoolean()
  known_only: boolean | null;
}
