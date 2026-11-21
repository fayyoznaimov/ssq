import { Module } from '@nestjs/common';
import { HelperService } from './helper.service';
import { LoggerService } from './logger.service';

@Module({
  providers: [HelperService, LoggerService],
  exports: [HelperService, LoggerService],
})
export class HelperModule {}
