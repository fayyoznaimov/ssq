import { IsNumberString, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export enum MediaTypes {
  AUDIO = 'audio',
  VIDEO = 'video',
  DOCUMENT = 'document',
  VOICE = 'voice',
  PHOTO = 'photo',
}

export interface Files {
  name: string;
  path: string;
  media_type: MediaTypes;
  caption: string;
}

export class SendMessageDto {
  @IsNumberString()
  from_user: number;

  @IsNumberString()
  to_user: number;

  // longer than Telegram's 4096 characters: the service sends it in several messages
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  message: string;

  // the deal the message is written from: it is recorded there (without it the CRM picks the deal)
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
