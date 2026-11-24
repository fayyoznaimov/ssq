import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../helper/validators';

/**
 * Why deals are lost (DEAL-11): the short list the manager picks from when a deal goes to the stage
 * of kind `lost` («Закрыто и не реализовано»). Stored as the label in deal.lost_reason, so a report
 * groups by it as it is; «Другое» needs the comment. The web client shows the list it gets from
 * GET /deals/:id/summary (lost_reasons).
 */
export const LOST_REASONS = [
  'Цена',
  'Сроки поставки',
  'Качество или образцы',
  'Ушёл к конкуренту',
  'Нет нужного товара',
  'Клиент не отвечает',
  'Неактуально для клиента',
  'Другое',
] as const;

export const LOST_REASON_OTHER = 'Другое';

/** PATCH /deals/:id/lost */
export class LostReasonDto {
  @Trim()
  @IsString()
  @IsIn(LOST_REASONS as unknown as string[], { message: 'Выберите причину из списка' })
  reason: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000, { message: 'Комментарий: не длиннее 1000 символов' })
  comment?: string;
}
