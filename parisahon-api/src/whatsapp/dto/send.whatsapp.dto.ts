import { IsNumberString, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /whatsapp/send-message (multipart, like Telegram): to a client contact of an open deal. */
export class SendWhatsAppDto {
  @IsNumberString()
  to_user: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  message?: string;
}
