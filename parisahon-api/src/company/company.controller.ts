import { ClientHistoryService } from '../deal/client-history.service';
import {
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
    private companyService: CompanyService,
    private eventService: EventsService,
    private clientHistory: ClientHistoryService,
  ) {}

  @Get()
  async searchByName(
    @Query() query: SearchCompanyDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.companyService.search(query));
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
    return instanceToPlain(this.companyService.create(data, request));
  }

  @Get(':id')
  async fetchById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.companyService.getById(id));
  }

  /** Every deal of the company: its own and those of its contacts (deals from Telegram / WhatsApp have no company). */
  @Get(':id/deals')
  async fetchCompanyDeals(@Param('id', ParseIntPipe) id: number) {
    return this.clientHistory.forCompany(id);
  }

  @Get(':id/events')
  async fetchCompanyEvents(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: SearchEventDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.eventService.fetchCompanyEvents(id, query));
  }

  @Get(':id/agent/:agent_id/source')
  async fetchSourceOfAgent(
    @Param() params: { id: string; agent_id: string },
    @Query() query: PaginationRequestDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      this.companyService.fetchSourceOfAgent(
        +params.id,
        +params.agent_id,
        query,
      ),
    );
  }

  @Patch(':id')
  async update(
    @Body() data: CreateCompanyFlatDto,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.companyService.update(id, request, data);
  }

  @Delete(':id')
  async delete(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.companyService.delete(id);
  }

  @Delete('fillers/:id')
  async deleteCompanyFiller(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.companyService.deleteCompanyFiller(id);
  }
}
