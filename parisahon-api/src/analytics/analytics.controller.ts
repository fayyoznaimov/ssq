import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { ControlService } from './control.service';
import { ControlQueryDto } from './dto/control.query.dto';
import { periodBounds } from './period';
import { DealAnalyticsQuery } from './dto/deal.analytics.dto';
import { UserAnalyticsQuery } from './dto/user.analytics.dto';
import { ConsolidatedReportQuery } from './dto/consolidated.report.query.dto';
import { PeriodQueryDto } from './dto/period.query.dto';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';

const pad = (n: number) => String(n).padStart(2, '0');
const plain = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A bound of a period as a moment in the server's time zone: "2026-11-01" is its local midnight (not UTC's). */
function moment(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(d[4]), Number(d[5]), Number(d[6]), Number(d[7]));
  return new Date(value);
}

/** from_date / till_date of a query, else the current month up to today; plain end dates include the whole day. */
function monthOrPeriod(query: { from_date?: string; till_date?: string }): { from: Date; till: Date } {
  const now = new Date();
  const bounds = periodBounds({
    from_date: query.from_date ?? plain(new Date(now.getFullYear(), now.getMonth(), 1)),
    till_date: query.till_date ?? plain(now),
  });
  return { from: moment(bounds.from_date), till: moment(bounds.till_date) };
}

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
    // "2026-11-01" used to become 05:00 of that day (a date alone is read as UTC midnight)
    const { from, till } = monthOrPeriod(query);
    return this.controlService.report({
      from,
      till,
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

  /** Calls per employee: from_date / till_date — the calls of that period, none — all time. */
  @Get('/calls')
  async fetchCallAnalytics(@Query() query: PeriodQueryDto): Promise<Record<string, any>> {
    return this.analyticsService.callAnalytics(query);
  }

  /** «По менеджерам»: every staff member for the period (default: the current month), see AnalyticsService.managerAnalytics. */
  @Get('/managers')
  async fetchManagerAnalytics(@Query() query: PeriodQueryDto): Promise<Record<string, any>> {
    const { from, till } = monthOrPeriod(query);
    return this.analyticsService.managerAnalytics(from, till);
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
