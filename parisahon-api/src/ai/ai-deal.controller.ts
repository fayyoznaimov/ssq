import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { DealAccess } from '../auth/access';
import { AiDealService } from './ai-deal.service';
import { AiSummaryService } from './ai-summary.service';
import { AcceptAiParamsDto } from './dto/ai.dto';

/**
 * The «ИИ» block of the deal page. The deal must be visible to the user (DealAccess: 404 otherwise);
 * the changes («Принять», «Снять») need the right to change it (403).
 */
@Controller('deals')
export class AiDealController {
  constructor(
    private ai: AiDealService,
    private summaries: AiSummaryService,
  ) {}

  /** The summary, open questions, promises, order parameters, flags and last turns of the deal. */
  @Get(':id/ai')
  @DealAccess('view')
  async view(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    return this.ai.view(request['user'], id);
  }

  /** «Обновить»: the summary for the current data (cached; made now, or status queued/running to poll). */
  @Post(':id/ai/summary')
  @HttpCode(200)
  @DealAccess('view')
  async summary(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    return this.summaries.request(request['user'], id);
  }

  /** «Принять»: order parameters into the empty deal fields of the same name. */
  @Post(':id/ai/accept')
  @HttpCode(200)
  @DealAccess('update')
  async accept(@Param('id', ParseIntPipe) id: number, @Body() body: AcceptAiParamsDto, @Req() request: Request) {
    return this.ai.accept(request['user'], id, body?.keys);
  }

  /** «Снять»: the question needs no answer / the promise is not needed. */
  @Post(':id/ai/items/:item_id/dismiss')
  @HttpCode(200)
  @DealAccess('update')
  async dismiss(@Param('id', ParseIntPipe) id: number, @Param('item_id', ParseIntPipe) itemId: number, @Req() request: Request) {
    return this.ai.dismiss(request['user'], id, itemId);
  }
}
