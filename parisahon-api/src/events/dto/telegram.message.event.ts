import { EventDto } from './event.dto';
import { User } from '../../user/user.entity';

export enum MessageMediaTypes {
  VOICE = 'voice',
  VIDEO = 'video',
  DOCUMENT = 'document',
  PHOTO = 'photo',
}

export class Location {
  laditude: string;

  longditude: string;
}

export class MessageFile {
  name: string;
  path: string;
  type: MessageMediaTypes;
  caption?: string;
}

export class TelegramMessageEvent extends EventDto {
  files: MessageFile[];

  message: string;

  from_user: User;

  to_user: User;

  location?: Location;
}
