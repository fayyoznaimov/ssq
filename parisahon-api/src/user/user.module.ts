import { ClientHistoryService } from '../deal/client-history.service';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
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
import { StaffFieldsInterceptor } from './staff-fields.interceptor';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserFiller, File, Deal]),
    FillerModule,
    HelperModule,
    EventsModule,
  ],
  providers: [
    UserService,
    ClientHistoryService,
    // every answer: an agent gets other staff accounts without rights, goals and messenger ids (ACL-17)
    { provide: APP_INTERCEPTOR, useClass: StaffFieldsInterceptor },
  ],
  exports: [UserService],
  controllers: [UserController],
})
export class UserModule {}
