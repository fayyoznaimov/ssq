import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event } from '../events/event.entity';
import { File } from '../file/file.entity';
import { DealModule } from '../deal/deal.module';
import { FileModule } from '../file/file.module';
import { MessengerModule } from '../messenger/messenger.module';
import { WhatsAppInboxService } from './whatsapp-inbox.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppInboxController } from './whatsapp-inbox.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, Deal, Event, File]), DealModule, FileModule, MessengerModule],
  providers: [WhatsAppInboxService, WhatsAppService],
  controllers: [WhatsAppController, WhatsAppInboxController],
})
export class WhatsAppModule {}
