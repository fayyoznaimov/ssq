import { Module } from '@nestjs/common';
import { LinkableService } from './linkable.service';
import { LinkableController } from './linkable.controller';

@Module({
  providers: [LinkableService],
  controllers: [LinkableController],
})
export class LinkableModule {}
