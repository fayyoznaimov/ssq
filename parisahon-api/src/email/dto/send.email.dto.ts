import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBooleanString,
  IsEmail,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  ValidationArguments,
  isEmail,
} from 'class-validator';

/**
 * Addresses as the forms send them: a list, or one field with several addresses
 * ("a@b.uz, c@d.uz; e@f.uz"): split, trimmed, empty ones dropped.
 */
export function splitAddresses({ value }: { value: unknown }): string[] | unknown {
  if (value === undefined || value === null || value === '') return value === '' ? [] : value;
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => String(item ?? '').split(/[,;\s]+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

/** "" (an empty select of the form) means "not given"; numbers and booleans of a JSON body as their text. */
const emptyToUndefined = ({ value }: { value: unknown }) => {
  if (value === '' || value === null) return undefined;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
};

function badAddresses(args: ValidationArguments): string {
  const values = Array.isArray(args.value) ? args.value : [args.value];
  const bad = values.filter((v) => !isEmail(String(v ?? '')));
  const field = args.property === 'cc' ? 'Копия' : 'Кому';
  return `Неверный адрес почты в поле «${field}»: ${bad.join(', ') || String(args.value ?? '')}`;
}

export class SendEmailDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsNumberString(undefined, { message: 'Неверный ящик отправителя' })
  transporter_id: number;

  /**
   * A deal the email is written from (the "Привязать сделку" field, the deal card): the email goes
   * into its history and no other. The user must be allowed to change it; not a closed one.
   */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsNumberString(undefined, { message: 'Неверная сделка' })
  deal_id: number;

  /**
   * The letter this one answers: In-Reply-To / References go with it (the client's mail program
   * keeps the thread), its deals get the reply too, and the original is quoted under the text.
   */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsNumberString(undefined, { message: 'Неверное письмо для ответа' })
  reply_to_email_id: number;

  /** "true": the sender's signature is added under the text by the server (it used to be put into the editor). */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsBooleanString({ message: 'with_signature: true или false' })
  with_signature: string;

  /** "false": no quote of the letter answered. */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsBooleanString({ message: 'quote: true или false' })
  quote: string;

  @IsString({ message: 'Тема письма должна быть текстом' })
  @MaxLength(998, { message: 'Тема письма слишком длинная (не больше 998 символов)' })
  subject: string;

  @IsString({ message: 'Текст письма должен быть текстом' })
  body: string;

  @Transform(splitAddresses)
  @IsArray({ message: 'Укажите адрес получателя' })
  @ArrayNotEmpty({ message: 'Укажите адрес получателя' })
  @ArrayMaxSize(50, { message: 'Не больше 50 получателей' })
  @IsEmail(undefined, { each: true, message: badAddresses })
  to: string[];

  @IsOptional()
  @Transform(splitAddresses)
  @IsArray({ message: 'Неверный список адресов в поле «Копия»' })
  @ArrayMaxSize(50, { message: 'Не больше 50 адресов в копии' })
  @IsEmail(undefined, { each: true, message: badAddresses })
  cc: string[];
}
