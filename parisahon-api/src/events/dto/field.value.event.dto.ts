import { EventDto } from './event.dto';
import { FieldsOf } from '../event.entity';

export class Field {
  name: string;

  new_value: string;

  old_value?: string = null;

  constructor(name: string, new_value: string, old_value: string = null) {
    this.name = name;
    this.new_value = new_value;
    this.old_value = old_value;
  }
}

export class FieldValueEventDto extends EventDto {
  fields: Field[];

  fields_of: FieldsOf;
}
