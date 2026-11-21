import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trigger } from './trigger.entity';
import { TriggerRun } from './trigger-run.entity';
import { Task } from '../task/task.entity';
import { Deal } from '../deal/deal.entity';
import { TriggerService } from './trigger.service';
import { TriggerActionsService } from './trigger-actions.service';
import { FileModule } from '../file/file.module';
import { HelperModule } from '../helper/helper.module';
import { EmailModule } from '../email/email.module';
import { TriggerScheduler } from './trigger.scheduler';
import { TriggerController } from './trigger.controller';
import { TriggerRunController } from './trigger-run.controller';
import { NotificationGateWayModule } from '../gateway/notification.gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Trigger, TriggerRun, Task, Deal]),
    FileModule,
    HelperModule,
    EmailModule,
    NotificationGateWayModule,
  ],
  exports: [TriggerService, TriggerScheduler],
  providers: [TriggerService, TriggerActionsService, TriggerScheduler],
  controllers: [TriggerController, TriggerRunController],
})
export class TriggerModule {}
