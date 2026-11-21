import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../company/company.entity';
import { User } from '../user/user.entity';
import { HelperModule } from '../helper/helper.module';
import { RecognitionController } from './recognition.controller';
import { RecognitionService } from './recognition.service';
import { ClaudeCliClient } from './claude-cli.client';

@Module({
  imports: [TypeOrmModule.forFeature([Company, User]), HelperModule],
  providers: [RecognitionService, ClaudeCliClient],
  controllers: [RecognitionController],
  exports: [RecognitionService, ClaudeCliClient],
})
export class RecognitionModule {}
