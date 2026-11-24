import { Module } from '@nestjs/common';
import { EventListener } from './listeners/event.listener';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event } from './event.entity';
import { EventsService } from './events.service';
import { EventClientSubscriber } from './event-client.subscriber';
import { HelperModule } from '../helper/helper.module';
import { User } from '../user/user.entity';
import { Email } from '../email/email.entity';
import { Deal } from 'src/deal/deal.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Event, User, Email, Deal]), HelperModule],
  providers: [EventListener, EventsService, EventClientSubscriber],
  exports: [EventsService],
})
export class EventsModule {}
