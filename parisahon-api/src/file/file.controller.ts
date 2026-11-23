import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';
import { Request } from 'express';
import { SearchFileDto } from './dto/search.file.dto';
import { FileAccessGuard } from './file-access.guard';
import { FileService } from './file.service';

@Controller('files')
export class FileController {
  constructor(private readonly fileService: FileService) {}

  /** The list of files: every file for admin and manager, an agent's deals and own uploads (FileService.fetchFiles). */
  @Get()
  @UseGuards(FileAccessGuard)
  async fetchAll(@Query() query: SearchFileDto, @Req() request: Request): Promise<Record<string, any>> {
    return instanceToPlain(await this.fileService.fetchFiles(query, request['user']));
  }
}
