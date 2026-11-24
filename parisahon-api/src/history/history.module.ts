import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

/** The readable client history of the deal page (DEAL-7, DEAL-10, DEAL-11, DEAL-14): see HistoryService. */
@Module({
  imports: [EventsModule],
  providers: [HistoryService],
  controllers: [HistoryController],
})
export class HistoryModule {}
