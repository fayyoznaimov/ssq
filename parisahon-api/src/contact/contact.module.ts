import { Module } from '@nestjs/common';
import { ContactService } from './contact.service';
import { ContactController } from './contact.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/user.entity';
import { Company } from '../company/company.entity';
import { HelperModule } from '../helper/helper.module';
import { UserFiller } from '../user/user.filler.entity';
import { CompanyFiller } from '../company/company.filler.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Company, UserFiller, CompanyFiller]),
    HelperModule,
  ],
  providers: [ContactService],
  controllers: [ContactController],
})
export class ContactModule {}
