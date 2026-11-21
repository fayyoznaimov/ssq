import { Controller, Get, Query } from '@nestjs/common';
import { LinkableService } from './linkable.service';
import { SearchLinkableDto } from './dto/search.linkable.dto';

@Controller('linkables')
export class LinkableController {
  constructor(private linkableService: LinkableService) {}

  @Get()
  async fetch(
    @Query() query: SearchLinkableDto,
  ): Promise<Record<string, any>[]> {
    return this.linkableService.fetch(query);
  }
}
