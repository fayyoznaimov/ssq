import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { SearchFileDto } from './dto/search.file.dto';
import { FileAccessGuard } from './file-access.guard';
import { FileService } from './file.service';

@Controller('files')
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Get()
  @UseGuards(FileAccessGuard)
  async fetchAll(@Query() query: SearchFileDto): Promise<Record<string, any>> {
    return instanceToPlain(await this.fileService.fetchFiles(query));
  }
}
