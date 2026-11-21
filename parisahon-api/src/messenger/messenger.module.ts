import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { Event } from '../events/event.entity';
import { DealModule } from '../deal/deal.module';
import { MessengerLookupService } from './messenger-lookup.service';
import { ClientDealsService } from './client-deals.service';

/** What Telegram and WhatsApp share: the client's deal for a message, finding the client in the other messenger. */
@Module({
  imports: [TypeOrmModule.forFeature([User, Deal, Event]), DealModule],
  providers: [MessengerLookupService, ClientDealsService],
  exports: [MessengerLookupService, ClientDealsService],
})
export class MessengerModule {}
