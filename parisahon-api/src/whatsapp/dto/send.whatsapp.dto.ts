import { IsNumberString, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** POST /whatsapp/send-message (multipart, like Telegram): to a client contact of an open deal. */
export class SendWhatsAppDto {
  @IsNumberString()
  to_user: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  message?: string;

  // the deal the message is written from: it is recorded there, for this contact (without it the CRM picks the deal)
  @IsOptional()
  @IsNumberString()
  deal_id?: string;

  // one id per message typed in the browser: a repeated click (or a retry after a timeout) does not send it twice
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  request_id?: string;
}
