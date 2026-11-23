import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event } from '../events/event.entity';
import { DealModule } from '../deal/deal.module';
import { AutomationModule } from '../automation/automation.module';
import { MessengerLookupService } from './messenger-lookup.service';
import { ClientDealsService } from './client-deals.service';
import { MessengerFilterService } from './messenger-filter.service';
import { MessengerHealthService } from './messenger-health.service';
import { MessengerController } from './messenger.controller';

/**
 * What Telegram and WhatsApp share: the client's deal for a message, finding the client in the other
 * messenger, which chats are not for the CRM («Не клиент», colleagues), and whether the sessions work.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, Deal, Event]), DealModule, AutomationModule],
  providers: [MessengerLookupService, ClientDealsService, MessengerFilterService, MessengerHealthService],
  controllers: [MessengerController],
  exports: [MessengerLookupService, ClientDealsService, MessengerFilterService, MessengerHealthService],
})
export class MessengerModule {}
