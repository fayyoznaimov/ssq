import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Access } from '../auth/access';
import { TrackingService } from './tracking.service';
import { SearchTrackingDto } from './dto/search.tracking.dto';
import { instanceToPlain } from 'class-transformer';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';

@Roles(AuthGuard.MANAGER_LEVEL)
@Controller('logs')
export class TrackingController {
  constructor(private trackingService: TrackingService) {}

  @Get()
  async fetchLogs(
    @Query() query: SearchTrackingDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.trackingService.fetchLogs(query, new Access(request['user']).canReadMail));
  }
}
