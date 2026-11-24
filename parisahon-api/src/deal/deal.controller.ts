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
  UploadedFiles,
  UseGuards,
} from '@nestjs/common';
import { RecordAccess } from '../auth/access';
import { DealService } from './deal.service';
import { ClientHistoryService } from './client-history.service';
import { Request } from 'express';
import { CreateDealDto } from './dto/create.deal.dto';
import { UpdateDealDto, UpdateStageOfDeal } from './dto/update.deal.dto';
import { AuthGuard } from '../auth/auth.guard';
import { Access, DealAccess } from '../auth/access';
import { instanceToPlain } from 'class-transformer';
import { EventsService } from '../events/events.service';
import { CreateCommentDto } from '../events/dto/create.comment.dto';
import { CreateChatMessageDto } from '../events/dto/create.chat.message.dto';
import { SearchDealBoardDto, SearchDealDto } from './dto/search.deal.dto';
import { SearchEventDto } from '../events/dto/search.event.dto';
import { PaginationRequestDto } from '../helper/dto/pagination.dto';
import { FileService } from '../file/file.service';
import { UploadFiles } from '../file/upload-files.decorator';
import { RemapEventDto } from '../events/dto/remap.event.dto';
import { DealFilter, WhichFiles } from '../trigger/dto/assign.trigger.dto';

@UseGuards(AuthGuard)
@Controller('deals')
export class DealController {
  constructor(
    private dealService: DealService,
    private eventService: EventsService,
    private fileService: FileService,
    private clientHistory: ClientHistoryService,
  ) {}

  @Get()
  async fetchAll(@Query() query: SearchDealDto, @Req() request: Request): Promise<Record<string, any>> {
    return instanceToPlain(this.dealService.fetchAll(query, request['user']));
  }

  @Get('/stats')
  async fetchDealStats(
    @Query() query: SearchDealDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.dealService.fetchDealStats(query, request['user']));
  }

  /**
   * The kanban: the totals of every column counted by the database and the first cards of
   * every column (`per_stage`), `before_id` for «Показать ещё» of one column (`stages`).
   */
  @Get('board')
  async fetchBoard(
    @Query() query: SearchDealBoardDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.dealService.fetchBoard(query, request['user']));
  }

  @Get('available-filters')
  async getAvailableFilters(): Promise<DealFilter[]> {
    return this.dealService.getDealFilters();
  }

  /** "Клиент" block of the deal card: the client's contacts, company and other deals. */
  @Get(':id/client-history')
  @DealAccess('view')
  async clientHistoryOf(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    // the client's other deals: only those the user may see
    return this.clientHistory.forDeal(id, new Access(request['user']));
  }

  @Get(':id')
  @DealAccess('view')
  async fetchOneById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.dealService.getByIdOrFail(id, true));
  }

  @Get(':id/events')
  @DealAccess('view')
  async fetchDealEvents(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: SearchEventDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      this.eventService.fetchDealEvents(id, query, new Access(request['user']).canReadMail),
    );
  }

  @Patch('events/remap')
  async remapEvent(
    @Body() data: RemapEventDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.eventService.remapEventToDifferentDeal(data, request['user']);
  }

  @Patch(':id/events/:event_id')
  @DealAccess('update')
  async markAsReplied(
    @Param('id', ParseIntPipe) dealId: number,
    @Param('event_id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.eventService.markAsReplied(id, dealId);
  }

  @Post()
  async create(
    @Body() data: CreateDealDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    if (!new Access(request['user']).can('deal', 'create')) {
      throw new ForbiddenException('No right to create deals');
    }
    // ACL-4: only companies and contacts the user may see are linked
    return instanceToPlain(
      this.dealService.create(request['user'].sub, data, { linkedBy: request['user'] }),
    );
  }

  @Post(':id/comments')
  @DealAccess('update')
  @UploadFiles()
  async postComment(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Body() data: CreateCommentDto,
    @Req() request: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    const savedFiles = await this.fileService.attachUploads(
      id,
      files,
      WhichFiles.FROM_COMMENTS,
      request['user'],
    );

    return instanceToPlain(
      this.eventService.postNewComment(id, data, request, savedFiles),
    );
  }

  @Patch(':id/comments/:event_id')
  @DealAccess('update')
  @UploadFiles()
  async updateComment(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Body() data: CreateCommentDto,
    @Param('id', ParseIntPipe) id: number,
    @Param('event_id', ParseIntPipe) event_id: number,
    @Req() request: Request,
  ): Promise<void> {
    const savedFiles = await this.fileService.attachUploads(
      id,
      files,
      WhichFiles.FROM_COMMENTS,
      request['user'],
    );

    return this.eventService.updateComment(
      id,
      event_id,
      data,
      request,
      savedFiles,
    );
  }

  @Delete(':id/comments/:event_id')
  @DealAccess('update')
  async deleteComment(
    @Param('id', ParseIntPipe) id: number,
    @Param('event_id', ParseIntPipe) event_id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.eventService.deleteComment(id, event_id, request);
  }

  @Post(':id/message')
  @DealAccess('update')
  @UploadFiles()
  async postChatMessage(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Body() data: CreateChatMessageDto,
    @Req() request: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    const savedFiles = await this.fileService.attachUploads(
      id,
      files,
      WhichFiles.FROM_MESSAGES,
      request['user'],
    );

    return instanceToPlain(
      this.eventService.postNewChatMessage(id, data, request, savedFiles),
    );
  }

  @Patch(':id')
  @DealAccess('update')
  async update(
    @Body() data: UpdateDealDto,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.dealService.update(id, request, data);
  }

  @Patch(':id/stage')
  @DealAccess('update')
  async updateStage(
    @Body() data: UpdateStageOfDeal,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.dealService.changeStage(id, data.stage_id, request);
  }

  /** Moves the deal to the trash (see DealTrashController) */
  @Delete(':id')
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.dealService.delete(id, request['user']);
  }

  @Delete('fillers/:id')
  @RecordAccess('dealFiller', 'update')
  async deleteCompanyFiller(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.dealService.deleteDealFiller(id);
  }

  @Get(':id/files')
  @DealAccess('view')
  async getFiles(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PaginationRequestDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.fileService.fetchSavedFiles(id, query));
  }

  @Get(':id/files/:file_id')
  @DealAccess('view')
  async getSingleFile(
    @Param('id', ParseIntPipe) deal_id: number,
    @Param('file_id', ParseIntPipe) file_id: number,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      await this.fileService.fetchSingleSavedFile(deal_id, file_id),
    );
  }

  @Post(':id/files')
  @DealAccess('update')
  @UploadFiles()
  async uploadFile(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Req() request: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      await this.fileService.attachUploads(
        id,
        files,
        WhichFiles.UPLOADED_FROM_FILES_TAB,
        request['user'],
      ),
    );
  }

  /** The file goes off the deal; the history of the deal says who removed which file. */
  @Delete(':id/files/:file_id')
  @DealAccess('update')
  async deleteSingleFile(
    @Param('id', ParseIntPipe) deal_id: number,
    @Param('file_id', ParseIntPipe) file_id: number,
    @Req() request: Request,
  ): Promise<void> {
    const file = await this.fileService.fetchSingleSavedFile(deal_id, file_id);
    await this.fileService.deleteUploadedFile(deal_id, file_id);
    await this.dealService.noteFileRemoved(deal_id, file.name, request);
  }
}
