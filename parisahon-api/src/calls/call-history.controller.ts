import { Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { Access, RecordAccess } from '../auth/access';
import { CallsService } from './calls.service';
import { CallDealService } from './call-deal.service';
import { CallFeedQueryDto, CallListQueryDto } from './dto/calls.dto';

/**
 * Call recordings for the people who work with the client (CallsController is the admin's settings page):
 *  GET  /calls/list — «Записи звонков»: every call for admin and manager (user_id, from, till, direction,
 *       number, page), anybody else their own recordings;
 *  GET  /calls/companies/:id — every call with a company, newest first: its contacts' and its own numbers,
 *       its deals and its contacts' cards (the «Звонки» tab of the company card); whoever may see the company,
 *       without the calls of the deals they may not see (their own recordings stay);
 *  GET  /calls/staff/:id — the recordings of one staff member with the client, the deal and the duration:
 *       their own, anyone's for admin and manager (the page «Записи звонков»);
 *  POST /calls/staff/:id/recordings/:recording_id/deal — «Создать сделку» on one of those recordings
 *       (a contact or a deal is created only with the right to create them).
 */
@Roles(AuthGuard.AGENT_LEVEL)
@Controller('calls')
export class CallHistoryController {
  constructor(
    private calls: CallsService,
    private callDeals: CallDealService,
  ) {}

  @Get('list')
  listCalls(@Query() query: CallListQueryDto, @Req() request: Request) {
    return this.calls.listCalls(query, new Access(request['user']));
  }

  @Get('companies/:id')
  @RecordAccess('company', 'view')
  companyCalls(@Param('id', ParseIntPipe) id: number, @Query() query: CallFeedQueryDto, @Req() request: Request) {
    // the calls of deals the user may not see stay out, as in the company's feed
    return this.calls.companyCalls(id, query, new Access(request['user']));
  }

  @Get('staff/:id')
  @RecordAccess('staffData', 'view')
  staffRecordings(@Param('id', ParseIntPipe) id: number, @Query() query: CallFeedQueryDto) {
    return this.calls.staffRecordings(id, query);
  }

  @Post('staff/:id/recordings/:recording_id/deal')
  @RecordAccess('staffData', 'view')
  dealOfOwnRecording(
    @Param('id', ParseIntPipe) id: number,
    @Param('recording_id', ParseIntPipe) recordingId: number,
    @Req() request: Request,
  ) {
    return this.callDeals.forRecording(recordingId, { staffId: id, actor: request['user'] });
  }
}
