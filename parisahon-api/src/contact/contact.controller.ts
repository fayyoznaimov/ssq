import { Controller, Get, Query } from '@nestjs/common';
import { ContactService } from './contact.service';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { ContactDto } from './dto/contact.dto';
import { SearchContactDto } from './dto/search.contact.dto';

@Controller('contacts')
export class ContactController {
  constructor(private contactService: ContactService) { }

  @Get()
  async fetchAll(
    @Query() query: SearchContactDto,
  ): Promise<PaginationResponseDto<ContactDto[]>> {
    return this.contactService.fetchAll(query);
  }
}
