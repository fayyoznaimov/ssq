import { EventDto } from './event.dto';
import { User } from '../../user/user.entity';

export class CtrAgentEventDto extends EventDto {
  ctr_agent: User;
}
