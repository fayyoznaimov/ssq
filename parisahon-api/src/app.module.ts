import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { SeedModule } from './seed/seed.module';
import { DealModule } from './deal/deal.module';
import { DealStageModule } from './deal_stage/deal_stage.module';
import { CompanyModule } from './company/company.module';
import { FillerModule } from './filler/filler.module';
import { GroupModule } from './group/group.module';
import { HelperModule } from './helper/helper.module';
import { TaskModule } from './task/task.module';
import { EventsModule } from './events/events.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TaskTypeModule } from './task_type/task_type.module';
import { ContactModule } from './contact/contact.module';
import { EmailModule } from './email/email.module';
import { FileModule } from './file/file.module';
import { LinkableModule } from './linkable/linkable.module';
import { options } from './datasource';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggingExceptionFilter } from './helper/logging-exception.filter';
import { TelegramModule } from './telegram/telegram.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { SettingModule } from './setting/setting.module';
import { TrackingModule } from './tracking/tracking.module';
import { ProductModule } from './product/product.module';
import { TriggerModule } from './trigger/trigger.module';
import { DesktopModule } from './desktop/desktop.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ObjectiveModule } from './objective/objective.module';
import { NotificationGateWayModule } from './gateway/notification.gateway.module';
import { NotificationModule } from './notification/notification.module';
import { RecognitionModule } from './recognition/recognition.module';
import { BotModule } from './bot/bot.module';
import { AutomationModule } from './automation/automation.module';
import { CallsModule } from './calls/calls.module';
import { AiModule } from './ai/ai.module';
import { AuditModule } from './audit/audit.module';
import { HistoryModule } from './history/history.module';
import { AuthGuard } from './auth/auth.guard';

@Module({
  imports: [
    TypeOrmModule.forRoot(options),
    EventEmitterModule.forRoot(),
    AuthModule,
    UserModule,
    SeedModule,
    DealModule,
    DealStageModule,
    CompanyModule,
    FillerModule,
    GroupModule,
    HelperModule,
    TaskModule,
    EventsModule,
    TaskTypeModule,
    ContactModule,
    EmailModule,
    FileModule,
    LinkableModule,
    TelegramModule,
    WhatsAppModule,
    SettingModule,
    TrackingModule,
    ProductModule,
    TriggerModule,
    DesktopModule,
    AnalyticsModule,
    ObjectiveModule,
    NotificationGateWayModule,
    NotificationModule,
    RecognitionModule,
    BotModule,
    AutomationModule,
    CallsModule,
    AiModule,
    // the readable client history of the deal page: header, the whole client, the reason of a loss (src/history)
    HistoryModule,
    // the journal «кто что изменил» and the request context of every request (src/audit)
    AuditModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: LoggingExceptionFilter,
    },
    // Every route of every controller requires a valid JWT by default.
    // The only way out is an explicit @Public() (see auth/decorator/public.decorator.ts).
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule { }
