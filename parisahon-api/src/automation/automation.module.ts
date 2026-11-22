import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from '../task/task.entity';
import { Deal } from '../deal/deal.entity';
import { NotificationGateWayModule } from '../gateway/notification.gateway.module';
import { AutoTaskService } from './auto-task.service';
import { AutopilotService } from './autopilot.service';

/** Rules the CRM runs by itself (see AutopilotService) and the tasks they create. */
@Module({
  imports: [TypeOrmModule.forFeature([Task, Deal]), NotificationGateWayModule],
  providers: [AutoTaskService, AutopilotService],
  exports: [AutoTaskService, AutopilotService],
})
export class AutomationModule {}
