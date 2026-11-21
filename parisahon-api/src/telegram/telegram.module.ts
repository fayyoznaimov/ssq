import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/user.entity';
import { HelperModule } from '../helper/helper.module';
import { Deal } from '../deal/deal.entity';
import { Event } from '../events/event.entity';
import { File } from '../file/file.entity';
import { DealModule } from '../deal/deal.module';
import { TriggerModule } from '../trigger/trigger.module';
import { TelegramInboxService } from './telegram-inbox.service';
import { TelegramInboxController } from './telegram-inbox.controller';
import { FileModule } from '../file/file.module';
import { MessengerModule } from '../messenger/messenger.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Deal, Event, File]),
    HelperModule,
    DealModule,
    TriggerModule,
    FileModule,
    MessengerModule,
  ],
  providers: [TelegramService, TelegramInboxService],
  controllers: [TelegramController, TelegramInboxController],
})
export class TelegramModule {}
