import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { ControlService } from './control.service';
import { AnalyticsController } from './analytics.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Deal } from 'src/deal/deal.entity';
import { DealStage } from 'src/deal_stage/deal_stage.entity';
import { DealStageRecord } from 'src/deal_stage/deal_stage.records.entity';
import { HelperModule } from 'src/helper/helper.module';
import { Event } from 'src/events/event.entity';
import { Recording } from './recordings.entity';
import { User } from 'src/user/user.entity';
import { Company } from 'src/company/company.entity';
import { Task } from 'src/task/task.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Deal,
      DealStage,
      DealStageRecord,
      Event,
      Recording,
      User,
      Company,
      Task,
    ]),
    HelperModule,
  ],
  providers: [AnalyticsService, ControlService],
  exports: [ControlService],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
