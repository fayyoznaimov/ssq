import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { LinkableService } from './linkable.service';
import { SearchLinkableDto } from './dto/search.linkable.dto';

@Controller('linkables')
export class LinkableController {
  constructor(private linkableService: LinkableService) {}

  /** Contacts, companies and deals for a task to link to: within the user's view rights. */
  @Get()
  async fetch(
    @Query() query: SearchLinkableDto,
    @Req() request: Request,
  ): Promise<Record<string, any>[]> {
    return this.linkableService.fetch(query, request['user']);
  }
}
