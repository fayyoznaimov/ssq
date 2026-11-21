import { Event, EventTypes, FieldsOf } from './event.entity';
import { Deal } from '../deal/deal.entity';
import { User } from '../user/user.entity';
import { Group } from '../group/group.entity';
import { EventDto } from './dto/event.dto';
import { Task } from '../task/task.entity';

export class EventBuilder extends Event {
  constructor(type: EventTypes) {
    super();
    this.type = type;
  }

  static fromType(type: EventTypes): EventBuilder {
    return new EventBuilder(type);
  }

  linkToDeal(deal: Deal): this {
    this.deal = deal;
    return this;
  }

  originatedBy(user: User): this {
    this.originated_by = user;
    return this;
  }

  addTargetFieldsIfGiven(data: EventDto): this {
    if (data.target_group) {
      return this.addTargetGroup(data.target_group);
    }

    if (data.target_user) {
      return this.addTargetUser(data.target_user);
    }

    return this;
  }

  addTargetUser(user: User): this {
    this.target_user = user;
    // Reset target group
    this.target_group = null;
    return this;
  }

  addTargetGroup(group: Group): this {
    this.target_group = group;
    // Reset target user
    this.target_user = null;
    return this;
  }

  addTask(task: Task): this {
    this.task = task;
    return this;
  }

  addBeforeState(beforeState: Record<string, any>): this {
    this.before_state = beforeState;
    return this;
  }

  addAfterState(afterState: Record<string, any>): this {
    this.after_state = afterState;
    return this;
  }

  addFieldOf(fieldOf: FieldsOf): this {
    this.field_of = fieldOf;
    return this;
  }

  addCreatedAt(date: Date): this {
    if (date) {
      this.created_at = date;
    }
    return this;
  }
}
