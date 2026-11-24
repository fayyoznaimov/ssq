import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { DealAccess } from '../auth/access';
import { AiInboundService } from './inbound.service';
import { AiLostService } from './lost.service';
import { InboundCorrectDto } from './dto/insights.dto';

/**
 * The AI features of src/ai-insights on a deal page. The deal must be visible to the user (DealAccess: 404
 * otherwise); a change or a new AI call needs the right to change it (403).
 */
@Controller('deals')
export class AiInsightsDealController {
  constructor(
    private inbound: AiInboundService,
    private lost: AiLostService,
  ) {}

  /** «Первое обращение»: what the AI read in the first message of the new contact (null: none). */
  @Get(':id/ai/inbound')
  @DealAccess('view')
  async inboundView(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    return this.inbound.forDeal(request['user'], id);
  }

  /** The category corrected (the deal's update right) or «просмотрено» (admin, manager). */
  @Patch(':id/ai/inbound')
  @DealAccess('update')
  async inboundCorrect(@Param('id', ParseIntPipe) id: number, @Body() body: InboundCorrectDto, @Req() request: Request) {
    return this.inbound.correct(request['user'], id, body ?? {});
  }

  /** The AI's proposal of the reason of a lost deal, if one was made for the current data. */
  @Get(':id/ai/lost-reason')
  @DealAccess('view')
  async lostView(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    return this.lost.view(request['user'], id);
  }

  /** «Почему сделка не реализована?»: the AI proposes the reason with a quote (the manager confirms it with PATCH /deals/:id/lost). */
  @Post(':id/ai/lost-reason')
  @HttpCode(200)
  @DealAccess('update')
  async lostRequest(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    return this.lost.request(request['user'], id);
  }
}
