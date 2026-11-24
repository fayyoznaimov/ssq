import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event } from '../events/event.entity';
import { HelperModule } from '../helper/helper.module';
import { FileController } from './file.controller';
import { FileLinkController } from './file-link.controller';
import { File } from './file.entity';
import { FileService } from './file.service';

@Module({
  imports: [TypeOrmModule.forFeature([File, Event]), HelperModule],
  providers: [FileService],
  exports: [FileService],
  controllers: [FileController, FileLinkController],
})
export class FileModule {}
