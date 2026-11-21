import { Module } from '@nestjs/common';
import { SeedService } from './seed.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/user.entity';
import { Group } from '../group/group.entity';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { TaskType as TaskTypeEntity } from '../task_type/task_type.entity';
import { Setting } from '../setting/setting.entity';
import { DealStageCollection } from 'src/deal_stage/deal_stage.collection.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Group,
      DealStage,
      TaskTypeEntity,
      Setting,
      DealStage,
      DealStageCollection,
    ]),
  ],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
