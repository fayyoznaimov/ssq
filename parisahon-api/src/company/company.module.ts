import { SimilarService } from './similar.service';
import { ClientHistoryService } from '../deal/client-history.service';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from './company.entity';
import { CompanyService } from './company.service';
import { CompanyController } from './company.controller';
import { CompanyFiller } from './company.filler.entity';
import { FillerModule } from '../filler/filler.module';
import { HelperModule } from '../helper/helper.module';
import { Deal } from '../deal/deal.entity';
import { EventsModule } from 'src/events/events.module';
import { User } from 'src/user/user.entity';
import { UserModule } from 'src/user/user.module';
import { FileModule } from 'src/file/file.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Company, CompanyFiller, Deal, User]),
    FillerModule,
    HelperModule,
    EventsModule,
    UserModule,
    FileModule,
  ],
  // ClientHistoryService: stateless, needs only the Deal repository (DealModule imports CompanyModule)
  providers: [SimilarService, CompanyService, ClientHistoryService],
  controllers: [CompanyController],
  exports: [CompanyService],
})
export class CompanyModule { }
