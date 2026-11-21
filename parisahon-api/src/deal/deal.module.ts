import { Module } from '@nestjs/common';
import { DealController } from './deal.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Deal } from './deal.entity';
import { DealService } from './deal.service';
import { ClientHistoryService } from './client-history.service';
import { DealFiller } from './deal.filler.entity';
import { Company } from '../company/company.entity';
import { UserModule } from '../user/user.module';
import { HelperModule } from '../helper/helper.module';
import { DealStageModule } from '../deal_stage/deal_stage.module';
import { FillerModule } from '../filler/filler.module';
import { EventsModule } from '../events/events.module';
import { FileModule } from '../file/file.module';
import { TriggerModule } from '../trigger/trigger.module';
import { DealStageRecord } from 'src/deal_stage/deal_stage.records.entity';
import { DealTrashController } from './deal-trash.controller';
import { DealTrashService } from './deal-trash.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Deal, DealFiller, Company, DealStageRecord]),
    UserModule,
    HelperModule,
    DealStageModule,
    FillerModule,
    EventsModule,
    FileModule,
    TriggerModule,
  ],
  providers: [DealService, DealTrashService, ClientHistoryService],
  // DealTrashController first: its /deals/trash routes must win over /deals/:id
  controllers: [DealTrashController, DealController],
  exports: [DealService, ClientHistoryService],
})
export class DealModule {}
