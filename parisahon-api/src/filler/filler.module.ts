import { Module } from '@nestjs/common';
import { FillerController } from './filler.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Filler } from './filler.entity';
import { FillerService } from './filler.service';

@Module({
  imports: [TypeOrmModule.forFeature([Filler])],
  providers: [FillerService],
  controllers: [FillerController],
  exports: [FillerService],
})
export class FillerModule {}
