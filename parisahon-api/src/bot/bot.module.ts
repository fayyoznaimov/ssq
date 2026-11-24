import { BotWaitingService } from './bot-waiting.service';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyModule } from '../company/company.module';
import { TaskModule } from '../task/task.module';
import { RecognitionModule } from '../recognition/recognition.module';
import { BotAccount, BotLinkCode, BotReminder } from './bot.entity';
import { BotService } from './bot.service';
import { BotCrmService } from './bot-crm.service';
import { BotToolsService } from './bot-tools.service';
import { BotAssistantService } from './bot-assistant.service';
import { BotSpeechService } from './bot-speech.service';
import { BotReminderService } from './bot-reminder.service';
import { BotMcpController } from './bot-mcp.controller';
import { BotLinkController } from './bot-link.controller';
import { AutomationModule } from '../automation/automation.module';
import { EventsModule } from '../events/events.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([BotAccount, BotLinkCode, BotReminder]),
    CompanyModule,
    TaskModule,
    RecognitionModule,
    AutomationModule,
    EventsModule,
    // the bot tool deal_summary (AiDealService)
    AiModule,
  ],
  providers: [BotService, BotCrmService, BotToolsService, BotAssistantService, BotSpeechService, BotReminderService, BotWaitingService],
  controllers: [BotMcpController, BotLinkController],
})
export class BotModule {}
