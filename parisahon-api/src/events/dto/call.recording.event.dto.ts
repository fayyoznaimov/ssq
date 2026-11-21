import { EventDto } from './event.dto';
import { Recording } from '../../analytics/recordings.entity';

/** A call recording was linked to a deal (CallsService): NEW_CALL_RECORDING. */
export class CallRecordingEventDto extends EventDto {
  recording: Recording;

  // an earlier call put into a deal afterwards (CallDealService): in the history, without the triggers
  history?: boolean;
}
