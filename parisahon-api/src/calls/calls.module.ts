import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecorderToken } from './recorder-token.entity';
import { CallUpload } from './call-upload.entity';
import { Recording } from '../analytics/recordings.entity';
import { User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { HelperModule } from '../helper/helper.module';
import { MessengerModule } from '../messenger/messenger.module';
import { CallsService } from './calls.service';
import { CallDealService } from './call-deal.service';
import { CallClientService } from './call-client.service';
import { CallsController } from './calls.controller';
import { CallsUploadController } from './calls-upload.controller';
import { CallHistoryController } from './call-history.controller';
import { CallsScheduler } from './calls.scheduler';

@Module({
  imports: [TypeOrmModule.forFeature([RecorderToken, CallUpload, Recording, User, Deal]), HelperModule, MessengerModule],
  providers: [CallsService, CallClientService, CallDealService, CallsScheduler],
  controllers: [CallsController, CallsUploadController, CallHistoryController],
  exports: [CallsService],
})
export class CallsModule {}
