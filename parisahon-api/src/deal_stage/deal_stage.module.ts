import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DealStage } from './deal_stage.entity';
import { DealStageService } from './deal_stage.service';
import { DealStageController } from './deal_stage.controller';
import { Deal } from '../deal/deal.entity';
import { Setting } from '../setting/setting.entity';
import { DealStageCollection } from './deal_stage.collection.entity';
import { HelperModule } from 'src/helper/helper.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DealStage, Deal, Setting, DealStageCollection]),
    HelperModule,
  ],
  providers: [DealStageService],
  controllers: [DealStageController],
  exports: [DealStageService],
})
export class DealStageModule {}
