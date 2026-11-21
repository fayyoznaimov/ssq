import { Task } from '../../task/task.entity';
import { EventDto } from './event.dto';

export class TaskEventDto extends EventDto {
  task: Task;
}
