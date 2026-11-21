import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { DealAnalyticsQuery } from './dto/deal.analytics.dto';
import { UserAnalyticsQuery } from './dto/user.analytics.dto';
import { ConsolidatedReportQuery } from './dto/consolidated.report.query.dto';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';

@Roles(AuthGuard.MANAGER_LEVEL)
@Controller('analytics')
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  @Get('/deals')
  async fetchOrderAnalytics(
    @Query() query: DealAnalyticsQuery,
  ): Promise<Record<string, any>> {
    return this.analyticsService.dealAnalytics(query);
  }

  @Get('/calls')
  async fetchCallAnalytics(): Promise<Record<string, any>> {
    return this.analyticsService.callAnalytics();
  }

  @Get('/users')
  async fetchUserAnalytics(
    @Query() query: UserAnalyticsQuery,
  ): Promise<Record<string, any>> {
    return this.analyticsService.userAnalytics(query);
  }

  @Get('/consolidated-report')
  async fetchConsolidatedReport(
    @Query() query: ConsolidatedReportQuery,
  ): Promise<Record<string, any>> {
    return this.analyticsService.consolidatedReportAnalytics(query);
  }
}
