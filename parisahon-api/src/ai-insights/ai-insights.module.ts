import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { NotificationGateWayModule } from '../gateway/notification.gateway.module';
import { AiNotice, ConversationReview, DealInbound, MarketMention } from './ai-insights.entity';
import { InsightsNotifier } from './insights-common';
import { AiMarketService } from './market.service';
import { AiInboundService } from './inbound.service';
import { AiDigestService } from './digest.service';
import { AiLostService } from './lost.service';
import { AiSupervisorService } from './supervisor.service';
import { AiInsightsController } from './insights.controller';
import { AiInsightsDealController } from './insights-deal.controller';

/**
 * More AI on top of the AI core (src/ai, its queue, budget, pause and turn analysis; switches:
 * ai-insights.config.ts, everything off while AI_FEATURES=0): «Сравнение с рынком» (AiMarketService),
 * «Разбор нового обращения» (AiInboundService), the morning and evening digests in the CRM bot (AiDigestService),
 * «Причина проигрыша» (AiLostService) and «ИИ-супервайзер» with the weekly tips (AiSupervisorService).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DealInbound, ConversationReview, AiNotice, MarketMention]),
    AiModule,
    AnalyticsModule,
    NotificationGateWayModule,
  ],
  providers: [InsightsNotifier, AiMarketService, AiInboundService, AiDigestService, AiLostService, AiSupervisorService],
  controllers: [AiInsightsController, AiInsightsDealController],
})
export class AiInsightsModule {}
