import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { ControlService } from './control.service';
import { ControlQueryDto } from './dto/control.query.dto';
import { periodBounds } from './period';
import { DealAnalyticsQuery } from './dto/deal.analytics.dto';
import { UserAnalyticsQuery } from './dto/user.analytics.dto';
import { ConsolidatedReportQuery } from './dto/consolidated.report.query.dto';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';

@Roles(AuthGuard.MANAGER_LEVEL)
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private analyticsService: AnalyticsService,
    private controlService: ControlService,
  ) {}

  /** Контроль менеджеров: response times, late answers, waiting clients, calls (see ControlService). */
  @Get('/control')
  async fetchControl(@Query() query: ControlQueryDto): Promise<Record<string, any>> {
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    const plain = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const bounds = periodBounds({
      from_date: query.from_date ?? plain(firstOfMonth),
      till_date: query.till_date ?? plain(now),
    });
    return this.controlService.report({
      from: new Date(bounds.from_date),
      till: new Date(bounds.till_date),
      slaMinutes: query.sla_minutes ?? Number(process.env.CONTROL_SLA_MINUTES || 15),
      waitingHours: query.waiting_hours ?? 2,
      agentId: query.agent_id,
    });
  }

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
