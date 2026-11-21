import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { DesktopService } from './desktop.service';
import { instanceToPlain } from 'class-transformer';
import { DesktopQueryDto } from './dto/desktop.query.dto';
import { Request } from 'express';
import { OwnStatsGuard } from '../auth/own-stats.guard';

@Controller('desktop')
export class DesktopController {
  constructor(private readonly desktopService: DesktopService) {}

  // my_stats=true: any staff user; company-wide numbers: admin and manager
  @UseGuards(OwnStatsGuard)
  @Get()
  async fetchStats(
    @Query() query: DesktopQueryDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.desktopService.fetchStats(query, request));
  }
}
