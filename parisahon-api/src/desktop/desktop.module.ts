import { Module } from '@nestjs/common';
import { DesktopService } from './desktop.service';
import { DesktopController } from './desktop.controller';
import { HelperModule } from 'src/helper/helper.module';

@Module({
  providers: [DesktopService],
  controllers: [DesktopController],
  imports: [HelperModule],
})
export class DesktopModule {}
