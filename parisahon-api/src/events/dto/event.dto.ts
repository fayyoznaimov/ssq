import { User } from '../../user/user.entity';
import { Group } from '../../group/group.entity';
import { Deal } from '../../deal/deal.entity';

export class EventDto {
  target_user?: User;

  target_group?: Group;

  deal: Deal;

  originated_by?: User;
}
