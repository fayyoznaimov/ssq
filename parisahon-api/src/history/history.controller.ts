import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { instanceToPlain } from 'class-transformer';
import { AuthGuard } from '../auth/auth.guard';
import { Access, DealAccess } from '../auth/access';
import { SearchEventDto } from '../events/dto/search.event.dto';
import { HistoryService } from './history.service';
import { LostReasonDto } from './lost-reasons';

/**
 * The readable history of a deal (src/history): the header of the deal page, the history of the
 * whole client and the reason of a lost deal. Under /deals/:id/… like the deal's own routes; the
 * deal must be visible to the user (DealAccess), the client's other deals are filtered by the
 * same rule (Access.dealSql).
 */
@UseGuards(AuthGuard)
@Controller('deals')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  /** № of the deal, its stage and days in it, the source, «клиент ждёт ответа», the reason of a loss. */
  @Get(':id/summary')
  @DealAccess('view')
  async summary(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    return this.history.summary(id, new Access(request['user']));
  }

  /** The history of every deal of the client the user may see (DEAL-7), with the filters and search of the feed. */
  @Get(':id/client-events')
  @DealAccess('view')
  async clientEvents(@Param('id', ParseIntPipe) id: number, @Query() query: SearchEventDto, @Req() request: Request) {
    return instanceToPlain(await this.history.clientFeed(id, query, new Access(request['user'])));
  }

  /** Why the deal was lost (DEAL-11): the deal must be in the stage of kind «lost»; changing it needs the deal's update right. */
  @Patch(':id/lost')
  @DealAccess('update')
  async lost(@Param('id', ParseIntPipe) id: number, @Body() data: LostReasonDto, @Req() request: Request) {
    return this.history.setLostReason(id, data, request['user'].sub);
  }
}
