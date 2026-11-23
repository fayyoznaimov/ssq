import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { ContactService } from './contact.service';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { ContactDto } from './dto/contact.dto';
import { SearchContactDto } from './dto/search.contact.dto';

@Controller('contacts')
export class ContactController {
  constructor(private contactService: ContactService) { }

  /** Contacts and companies within the user's view rights (the scope was not applied to the list). */
  @Get()
  async fetchAll(
    @Query() query: SearchContactDto,
    @Req() request: Request,
  ): Promise<PaginationResponseDto<ContactDto[]>> {
    return this.contactService.fetchAll(query, request['user']);
  }
}
