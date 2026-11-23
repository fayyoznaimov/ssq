import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { TriggerService } from './trigger.service';
import { AssignTriggerDto } from './dto/assign.trigger.dto';
import { Trigger } from './trigger.entity';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';

@Controller('stages/:id')
export class TriggerController {
  constructor(private readonly triggerService: TriggerService) {}

  /** The triggers of a stage; admins and managers also get `runs` (failed runs of 7 days, the last error). */
  @Get('triggers')
  async fetchAll(@Param('id', ParseIntPipe) id: number, @Req() request: Request): Promise<any> {
    return this.triggerService.fetchAll(id, request['user']);
  }

  @Get('triggers/:trigger_id')
  async fetchOne(
    @Param('id', ParseIntPipe) id: number,
    @Param('trigger_id', ParseIntPipe) triggerId: number,
  ): Promise<any> {
    return this.triggerService.fetchOne(id, triggerId);
  }

  /** The schedule and the history of a trigger (trigger_run rows), newest first; only the deals the user may see. */
  @Get('triggers/:trigger_id/runs')
  async fetchRuns(
    @Param('id', ParseIntPipe) id: number,
    @Param('trigger_id', ParseIntPipe) triggerId: number,
    @Req() request: Request,
    @Query('limit') limit?: string,
  ): Promise<any[]> {
    return this.triggerService.fetchRuns(id, triggerId, Number(limit) || 100, request['user']);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Post('triggers')
  async attachTrigger(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: AssignTriggerDto,
  ): Promise<Trigger> {
    return this.triggerService.assignTriggerToDealStage(data, id);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Patch('triggers/:triggerId')
  async updateTrigger(
    @Param('id', ParseIntPipe) dealStageId: number,
    @Param('triggerId', ParseIntPipe) triggerId: number,
    @Body() data: AssignTriggerDto,
  ): Promise<void> {
    return this.triggerService.updateTrigger(triggerId, dealStageId, data);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Delete('triggers/:triggerId')
  async deleteTrigger(
    @Param('id', ParseIntPipe) dealStageId: number,
    @Param('triggerId', ParseIntPipe) triggerId: number,
  ): Promise<void> {
    return this.triggerService.deleteTrigger(triggerId, dealStageId);
  }
}
