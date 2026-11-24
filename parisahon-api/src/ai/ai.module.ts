import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from '../task/task.entity';
import { RecognitionModule } from '../recognition/recognition.module';
import { AutomationModule } from '../automation/automation.module';
import { NotificationGateWayModule } from '../gateway/notification.gateway.module';
import { DealModule } from '../deal/deal.module';
import { AiJob, AiUsage } from './ai-job.entity';
import { ConversationItem, ConversationTurn } from './conversation.entity';
import { AiQueueService } from './ai-queue.service';
import { AiTaskService } from './ai-task.service';
import { AiTurnService } from './ai-turn.service';
import { AiSummaryService } from './ai-summary.service';
import { AiDealService } from './ai-deal.service';
import { AiDealController } from './ai-deal.controller';
import { AiController } from './ai.controller';

/**
 * The AI of the CRM (switches: ai.config.ts, AI_FEATURES=0 by default): the queue of AI jobs over the
 * server's Claude CLI with a budget and a pause (AiQueueService), «Разбор хода» with «Вопрос без ответа» and
 * «Обещания → задачи» (AiTurnService), «Сводка сделки» (AiSummaryService), the «ИИ» block of the deal
 * page and the bot tool deal_summary (AiDealService, exported for the bot).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AiJob, AiUsage, ConversationTurn, ConversationItem, Task]),
    RecognitionModule,
    AutomationModule,
    NotificationGateWayModule,
    DealModule,
  ],
  providers: [AiQueueService, AiTaskService, AiTurnService, AiSummaryService, AiDealService],
  controllers: [AiDealController, AiController],
  // AiQueueService: the one queue, budget and pause of all AI (src/ai-insights registers its jobs there)
  exports: [AiDealService, AiQueueService],
})
export class AiModule {}
