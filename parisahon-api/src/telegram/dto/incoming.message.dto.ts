import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * What parisahon-telegram-service posts to POST /telegram/incoming for every
 * message of a manager's private chat (incoming, or sent from the phone).
 */
export class IncomingChatDto {
  @IsInt()
  tg_id: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  // client's profile photo saved by the service in public/uploads
  @IsOptional()
  @IsString()
  @MaxLength(255)
  photo?: string | null;
}

export class IncomingFileDto {
  @IsString()
  @MaxLength(255)
  name: string;

  // file name inside parisahon-api/public/uploads (the service saves it there); '' for a remote file
  @IsString()
  @MaxLength(255)
  path: string;

  // true: too big to save (TG_MAX_AUTO_DOWNLOAD_MB of the service), the file stays in Telegram
  @IsOptional()
  @IsBoolean()
  remote?: boolean;

  @IsOptional()
  @IsNumber()
  size?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  mime?: string | null;

  @IsString()
  @MaxLength(32)
  type: string;

  @IsOptional()
  @IsString()
  caption?: string;
}

export class IncomingMessageDto {
  // CRM user whose Telegram account received / sent the message
  @IsInt()
  agent_id: number;

  // Telegram id of that account; stored on the user when it changes
  @IsOptional()
  @IsInt()
  agent_tg_id?: number;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => IncomingChatDto)
  chat: IncomingChatDto;

  @IsInt()
  tg_message_id: number;

  @IsOptional()
  @IsString()
  text?: string;

  // true: the manager wrote to the client (from the phone or through the CRM)
  @IsBoolean()
  outgoing: boolean;

  @IsOptional()
  @IsISO8601()
  date?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IncomingFileDto)
  files?: IncomingFileDto[];

  @IsOptional()
  @IsObject()
  contact?: Record<string, any>;

  @IsOptional()
  @IsObject()
  location?: Record<string, any>;
}
