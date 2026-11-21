import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IncomingFileDto } from '../../telegram/dto/incoming.message.dto';

/** The client's chat as parisahon-whatsapp-service sees it. */
export class WhatsAppChatDto {
  // chat id (JID): "998901112233@s.whatsapp.net" or "…@lid" when WhatsApp hides the number
  @IsString()
  @MaxLength(64)
  wa_id: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string | null;

  // client's profile photo saved by the service in public/uploads
  @IsOptional()
  @IsString()
  @MaxLength(255)
  photo?: string | null;
}

/** What the service posts to POST /whatsapp/incoming for every message of a manager's 1:1 chat. */
export class IncomingWhatsAppDto {
  // CRM user whose WhatsApp received / sent the message
  @IsInt()
  agent_id: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  agent_phone?: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => WhatsAppChatDto)
  chat: WhatsAppChatDto;

  @IsString()
  @MaxLength(128)
  wa_message_id: string;

  @IsOptional()
  @IsString()
  text?: string;

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
}
