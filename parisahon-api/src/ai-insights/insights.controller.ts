import { Body, Controller, Get, HttpCode, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuditJournal } from '../audit/audit-journal';
import { AI2 } from './ai-insights.config';
import { InsightsNotifier } from './insights-common';
import { AiMarketService } from './market.service';
import { AiInboundService } from './inbound.service';
import { AiSupervisorService } from './supervisor.service';
import { AiDigestService } from './digest.service';
import { InboundListDto, InsightsPeriodDto, InsightsRunDto, MarketQueryDto } from './dto/insights.dto';

/**
 * The AI features of src/ai-insights outside a deal:
 *  - «Рынок» (GET /ai/market, POST /ai/market/summary): every staff user, only the deals they may see;
 *  - «Новые обращения» and «Качество диалогов» of the control page (GET /ai/inbound, GET /ai/quality): admins and
 *    managers, like the control page itself;
 *  - the switches (GET /ai/insights/status, admins and managers) and a job of the features now
 *    (POST /ai/insights/run, admin: a digest, the weekly tips, the review of past dialogs).
 */
@Controller('ai')
export class AiInsightsController {
  constructor(
    private market: AiMarketService,
    private inbound: AiInboundService,
    private supervisor: AiSupervisorService,
    private digests: AiDigestService,
    private notifier: InsightsNotifier,
  ) {}

  /** «Рынок»: our prices against what clients report from competitors, the quotes, the signals; filters. */
  @Get('market')
  async marketReport(@Query() query: MarketQueryDto, @Req() request: Request) {
    return this.market.report(request['user'], query);
  }

  /** «Сводка ИИ» of the market page (cached for the same data). */
  @Post('market/summary')
  @HttpCode(200)
  async marketSummary(@Body() body: MarketQueryDto, @Req() request: Request) {
    return this.market.summarize(request['user'], body ?? {});
  }

  /** «Новые обращения»: the AI's reading of the first messages of new contacts, «не заявки» first. */
  @Get('inbound')
  @Roles(AuthGuard.MANAGER_LEVEL)
  async inboundList(@Query() query: InboundListDto, @Req() request: Request) {
    return this.inbound.list(request['user'], query);
  }

  /** «Качество диалогов»: the nightly reviews of the period per employee (advisory). */
  @Get('quality')
  @Roles(AuthGuard.MANAGER_LEVEL)
  async quality(@Query() query: InsightsPeriodDto, @Req() request: Request) {
    return this.supervisor.quality(request['user'], query);
  }

  /** The switches of these features and whether the CRM bot can send their messages. */
  @Get('insights/status')
  @Roles(AuthGuard.MANAGER_LEVEL)
  async status() {
    return { features: AI2.features(), bot: this.notifier.enabled };
  }

  /**
   * A job now, by hand (admin): the morning / evening digest or the weekly tips to these employees (all who linked
   * the bot when none; each still once a day), the review of the past days' dialogs (these deals / days). The
   * switches decide as for the scheduled run; the time of day and the working day do not.
   */
  @Post('insights/run')
  @HttpCode(200)
  @Roles(AuthGuard.ADMIN_LEVEL)
  async run(@Body() body: InsightsRunDto) {
    return AuditJournal.job('ai', `ai-insights:${body.job}`, async () => {
      const now = new Date();
      switch (body.job) {
        case 'morning':
          if (!AI2.digestMorning) throw new ServiceUnavailableException('Утренний дайджест выключен (AI_DIGEST_MORNING)');
          return { job: body.job, sent: await this.digests.morning(now, body.user_ids) };
        case 'evening': {
          if (!AI2.digestEvening) throw new ServiceUnavailableException('Вечерний дайджест выключен (AI_DIGEST_EVENING)');
          const result = await this.digests.evening(now, { userIds: body.user_ids, waitMs: (body.wait_sec ?? 30) * 1000 || 1 });
          return { job: body.job, ...result };
        }
        case 'supervisor':
          if (!AI2.supervisor) throw new ServiceUnavailableException('ИИ-супервайзер выключен (AI_SUPERVISOR)');
          return { job: body.job, ...(await this.supervisor.plan(now, { dealIds: body.deal_ids, days: body.days })) };
        case 'tips':
          if (!AI2.tips) throw new ServiceUnavailableException('Еженедельные подсказки выключены (AI_SUPERVISOR_TIPS)');
          return { job: body.job, sent: await this.supervisor.sendTips(now, body.user_ids) };
      }
    });
  }
}
