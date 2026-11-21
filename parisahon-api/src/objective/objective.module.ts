import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Deal } from 'src/deal/deal.entity';
import { Group } from 'src/group/group.entity';
import { HelperModule } from 'src/helper/helper.module';
import { User } from 'src/user/user.entity';
import { ObjectiveService } from './objective.service';
import { ObjectiveController } from './objective.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, Group, Deal]), HelperModule],
  providers: [ObjectiveService],
  controllers: [ObjectiveController],
})
export class ObjectiveModule {}
