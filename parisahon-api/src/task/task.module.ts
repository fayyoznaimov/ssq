import { Module } from '@nestjs/common';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from './task.entity';
import { HelperModule } from '../helper/helper.module';
import { EventsModule } from '../events/events.module';
import { NotificationGateWayModule } from 'src/gateway/notification.gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Task]),
    HelperModule,
    EventsModule,
    NotificationGateWayModule,
  ],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService],
})
export class TaskModule { }
