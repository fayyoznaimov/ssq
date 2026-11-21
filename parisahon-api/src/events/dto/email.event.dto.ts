import { EventDto } from './event.dto';
import { Email } from '../../email/email.entity';

export class EmailEventDto extends EventDto {
  email: Email;
}
