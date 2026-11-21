import { EventDto } from './event.dto';
import { Deal } from '../../deal/deal.entity';

export class DealEventDto extends EventDto {
  deal: Deal;
}
