import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event } from '../events/event.entity';
import { HelperModule } from '../helper/helper.module';

@Module({
  providers: [TrackingService],
  controllers: [TrackingController],
  imports: [TypeOrmModule.forFeature([Event]), HelperModule],
})
export class TrackingModule {}
