import { Controller, Get, Query } from '@nestjs/common';
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
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.trackingService.fetchLogs(query));
  }
}
