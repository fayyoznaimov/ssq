import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { HelperService } from '../helper/helper.service';
import { CallsService } from './calls.service';
import { CallDealService } from './call-deal.service';
import { IssueTokenDto, QueueQueryDto, RecordingsQueryDto } from './dto/calls.dto';

/** Call recordings for the admin: recorder tokens, the queue, every recording. */
@Roles(AuthGuard.ADMIN_LEVEL)
@Controller('calls')
export class CallsController {
  constructor(
    private calls: CallsService,
    private callDeals: CallDealService,
    private helperService: HelperService,
  ) {}

  @Get('tokens')
  tokens() {
    return this.calls.listTokens();
  }

  @Post('tokens')
  async issue(@Req() request: Request, @Body() data: IssueTokenDto) {
    const admin = await this.helperService.extractUserFromRequest(request);
    return this.calls.issueToken(data.user_id, admin);
  }

  @Delete('tokens/:user_id')
  revoke(@Param('user_id', ParseIntPipe) userId: number) {
    return this.calls.revokeToken(userId);
  }

  /** Where the phones send recordings by FTP (login: anything, password: the recorder token); null — FTP is off. */
  @Get('ftp')
  ftp() {
    return { address: CallsService.ftpAddress() };
  }

  @Get('queue')
  queue(@Query() query: QueueQueryDto) {
    return this.calls.queue(query);
  }

  @Post('queue/:id/retry')
  retry(@Param('id', ParseIntPipe) id: number) {
    return this.calls.retry(id);
  }

  @Delete('queue/:id')
  discard(@Param('id', ParseIntPipe) id: number) {
    return this.calls.discard(id);
  }

  /** Process the pending files now (the scheduler does it every CALLS_SCHEDULER_SEC seconds). */
  @Post('process')
  process() {
    return this.calls.processPending();
  }

  @Get('recordings')
  recordings(@Query() query: RecordingsQueryDto) {
    return this.calls.recordings(query);
  }

  /** «Создать сделку» on a recording without one: the client by its number (found or created) and their deal. */
  @Post('recordings/:id/deal')
  dealOfRecording(@Param('id', ParseIntPipe) id: number) {
    return this.callDeals.forRecording(id);
  }
}
