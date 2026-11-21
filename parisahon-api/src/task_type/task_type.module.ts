import { Module } from '@nestjs/common';
import { TaskTypeService } from './task_type.service';
import { TaskTypeController } from './task_type.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaskType as TaskTypeEntity } from './task_type.entity';
import { HelperModule } from '../helper/helper.module';

@Module({
  imports: [TypeOrmModule.forFeature([TaskTypeEntity]), HelperModule],
  providers: [TaskTypeService],
  controllers: [TaskTypeController],
})
export class TaskTypeModule {}
