import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event } from '../events/event.entity';
import { File } from '../file/file.entity';
import { DealModule } from '../deal/deal.module';
import { FileModule } from '../file/file.module';
import { MessengerModule } from '../messenger/messenger.module';
import { TriggerModule } from '../trigger/trigger.module';
import { WhatsAppInboxService } from './whatsapp-inbox.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppInboxController } from './whatsapp-inbox.controller';

@Module({
  // TriggerModule: the stage's triggers «при сообщении в WhatsApp» (WA-3), like Telegram's
  imports: [TypeOrmModule.forFeature([User, Deal, Event, File]), DealModule, FileModule, MessengerModule, TriggerModule],
  providers: [WhatsAppInboxService, WhatsAppService],
  controllers: [WhatsAppController, WhatsAppInboxController],
})
export class WhatsAppModule {}
