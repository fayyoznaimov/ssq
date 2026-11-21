import { ClientHistoryService } from '../deal/client-history.service';
import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UserController } from './user.controller';
import { FillerModule } from '../filler/filler.module';
import { UserFiller } from './user.filler.entity';
import { HelperModule } from '../helper/helper.module';
import { File } from '../file/file.entity';
import { Deal } from '../deal/deal.entity';
import { EventsModule } from 'src/events/events.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserFiller, File, Deal]),
    FillerModule,
    HelperModule,
    EventsModule,
  ],
  providers: [UserService, ClientHistoryService],
  exports: [UserService],
  controllers: [UserController],
})
export class UserModule {}
