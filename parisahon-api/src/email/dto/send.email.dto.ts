import {
  IsArray,
  IsEmail,
  IsNumberString,
  IsOptional,
  IsString,
} from 'class-validator';

export class SendEmailDto {
  @IsOptional()
  @IsNumberString()
  transporter_id: number;

  /**
   * A deal the email is written from (the "Привязать сделку" field). The email
   * is added to its history in addition to the open deals of the recipients.
   */
  @IsOptional()
  @IsNumberString()
  deal_id: number;

  @IsString()
  subject: string;

  @IsString()
  body: string;

  @IsEmail(undefined, { each: true })
  @IsArray()
  to: string[];

  @IsOptional()
  @IsEmail(undefined, { each: true })
  @IsArray()
  cc: string[];
}
