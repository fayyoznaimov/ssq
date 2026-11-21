import { instanceToPlain } from 'class-transformer';

export class EventWrapper {
  data: object;

  constructor(value: any) {
    this.data = value;
  }
  static fromEntity(entity: any): Record<string, any> {
    return instanceToPlain(new EventWrapper(entity));
  }
}
