import { IsNumberString, IsOptional, IsString } from 'class-validator';

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

  @IsOptional()
  @IsString()
  message: string;
}
