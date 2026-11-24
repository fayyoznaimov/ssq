import { ArrayMaxSize, IsArray, IsIn, IsOptional } from 'class-validator';
import { ORDER_PARAMS, OrderParamKey } from '../ai-prompts';

/** POST /deals/:id/ai/accept: the order parameters to put into the deal's fields (all found ones when omitted). */
export class AcceptAiParamsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ORDER_PARAMS.length)
  @IsIn(
    ORDER_PARAMS.map((p) => p.key),
    { each: true, message: 'Неизвестный параметр заказа' },
  )
  keys?: OrderParamKey[];
}
