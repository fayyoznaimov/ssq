import { EventDto } from './event.dto';
import { DealStage } from '../../deal_stage/deal_stage.entity';

export class DealStageEventDto extends EventDto {
  new_stage: DealStage;

  old_stage: DealStage;
}
