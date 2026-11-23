import { ClientHistoryService } from '../deal/client-history.service';
import {
  ForbiddenException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Access, RecordAccess } from '../auth/access';
import { Roles } from '../auth/decorator/roles.decorator';
import { SimilarService } from './similar.service';
import { SimilarQueryDto } from './dto/similar.query.dto';
import { CompanyService } from './company.service';
import { CreateCompanyDto } from './dto/create.company.dto';
import {
  CreateCompanyFlatDto,
} from './dto/update.company.dto';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { instanceToPlain } from 'class-transformer';
import { SearchCompanyDto } from './dto/search.company.dto';
import { EventsService } from 'src/events/events.service';
import { SearchEventDto } from 'src/events/dto/search.event.dto';
import { PaginationRequestDto } from 'src/helper/dto/pagination.dto';

@UseGuards(AuthGuard)
@Controller('companies')
export class CompanyController {
  constructor(
    private similarService: SimilarService,
    private companyService: CompanyService,
    private eventService: EventsService,
    private clientHistory: ClientHistoryService,
  ) {}

  /** The list: only the companies the user may see (company view right). */
  @Get()
  async searchByName(
    @Query() query: SearchCompanyDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.companyService.search(query, request['user']));
  }

  @Get('statistics')
  async getCompanyStats(): Promise<any> {
    return this.companyService.getCompanyStats();
  }

  @Post()
  async create(
    @Body() data: CreateCompanyDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    const access = new Access(request['user']);
    if (!access.can('company', 'create')) {
      throw new ForbiddenException('No right to create companies');
    }
    // contacts made together with the company: «Создание контактов» (was not checked)
    if ((data.users ?? []).length && !access.can('contact', 'create')) {
      throw new ForbiddenException('No right to create contacts');
    }
    // the web form: a contact's phone must not be another contact's (the bot's card has its own warnings)
    return instanceToPlain(await this.companyService.create(data, request, { checkContactPhones: true }));
  }

  /** Companies and contacts that look like the one being typed, with reasons and hints. */
  @Get('similar')
  async similar(@Query() query: SimilarQueryDto, @Req() request: Request) {
    return this.similarService.find(query, request['user']);
  }

  /** Deleted companies (newest first), to restore one deleted by mistake: admin and manager. */
  @Get('trash')
  @Roles(AuthGuard.MANAGER_LEVEL)
  async trash(@Query() query: SearchCompanyDto): Promise<Record<string, any>> {
    return instanceToPlain(await this.companyService.trash(query));
  }

  @Get(':id')
  @RecordAccess('company', 'view')
  async fetchById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.companyService.getById(id));
  }

  /**
   * Every deal of the company the user may see: its own and those of its contacts (deals from
   * Telegram / WhatsApp have no company).
   */
  @Get(':id/deals')
  @RecordAccess('company', 'view')
  async fetchCompanyDeals(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    return this.clientHistory.forCompany(id, new Access(request['user']));
  }

  /** The feed of the company: the events of its deals the user may see; letters only with the "mail" switch. */
  @Get(':id/events')
  @RecordAccess('company', 'view')
  async fetchCompanyEvents(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: SearchEventDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      this.eventService.fetchCompanyEvents(id, query, new Access(request['user'])),
    );
  }

  /**
   * The «Файлы» and «Звонки» tabs of the company: files of all its deals and its call recordings
   * (by the deals, the contacts and the phones), newest first, within the deals the user may see.
   */
  @Get(':id/sources')
  @RecordAccess('company', 'view')
  async fetchCompanySources(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PaginationRequestDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.companyService.fetchCompanySources(id, query, request['user']));
  }

  @Get(':id/agent/:agent_id/source')
  @RecordAccess('company', 'view')
  async fetchSourceOfAgent(
    @Param() params: { id: string; agent_id: string },
    @Query() query: PaginationRequestDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      await this.companyService.fetchSourceOfAgent(
        +params.id,
        +params.agent_id,
        query,
        request['user'],
      ),
    );
  }

  @Patch(':id')
  @RecordAccess('company', 'update')
  async update(
    @Body() data: CreateCompanyFlatDto,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.companyService.update(id, request, data, request['user']);
  }

  /** A deleted company back in the lists (with its contacts and deals): admin and manager. */
  @Patch(':id/restore')
  @Roles(AuthGuard.MANAGER_LEVEL)
  async restore(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.companyService.restore(id);
  }

  @Delete(':id')
  @RecordAccess('company', 'delete')
  async delete(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.companyService.delete(id);
  }

  @Delete('fillers/:id')
  @RecordAccess('companyFiller', 'update')
  async deleteCompanyFiller(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.companyService.deleteCompanyFiller(id);
  }
}
