import { EventDto } from './event.dto';
import { FieldsOf } from '../event.entity';

export class Field {
  name: string;

  new_value: string;

  old_value?: string = null;

  // what the field is of, by name, when the deal has several (a product: «Полотенце 70×140»)
  subject?: string = null;

  constructor(name: string, new_value: string, old_value: string = null, subject: string = null) {
    this.name = name;
    this.new_value = new_value;
    this.old_value = old_value;
    this.subject = subject;
  }
}

export class FieldValueEventDto extends EventDto {
  fields: Field[];

  fields_of: FieldsOf;
}
