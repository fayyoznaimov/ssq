import {
  HttpCode,
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
  UseInterceptors,
} from '@nestjs/common';
import { EmailService } from './email.service';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { Email } from './email.entity';
import { CreateTransporterDto } from './dto/create.transporter.dto';
import { instanceToPlain } from 'class-transformer';
import { Request } from 'express';
import { UpdateTransporterDto } from './dto/update.transporter.dto';
import { AuthGuard } from '../auth/auth.guard';
import { SendEmailDto } from './dto/send.email.dto';
import { SearchEmailDto } from './dto/search.email.dto';
import { FilesInterceptor } from '@nestjs/platform-express';
import { FileService } from '../file/file.service';
import { CreateTemplateDto } from './dto/create.template.dto';
import { CreateSignDto, UserWithSign } from './dto/create.sign.dto';
import { HelperService } from '../helper/helper.service';
import { EmailTo } from './email_to.entity';
import { FetchEmailToDto } from './dto/fetch.email.to.dto';
import { MailAccessGuard } from './mail-access.guard';
import { MailAssistService } from './mail-assist.service';
import { AssistEmailDto } from './dto/assist.email.dto';
import { CreateDealsFromLettersDto, LinkLetterContactsDto, LinkLetterDto, MarkReadDto } from './dto/create.deals.dto';

@UseGuards(AuthGuard, MailAccessGuard)
@Controller('emails')
export class EmailController {
  constructor(
    private mailAssist: MailAssistService,
    private emailService: EmailService,
    private helperService: HelperService,
  ) { }

  @Get('sync')
  async synchronize(
    @Query() query: SearchEmailDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      this.emailService.syncEmailsFromAllMailBoxes(query, request),
    );
  }
  /** How the copying of the mailboxes went: the last successful run, failing mailboxes and letters. */
  @Get('sync-status')
  syncStatus(): Record<string, any> {
    return this.emailService.syncStatus();
  }

  /** Writing assistant: check spelling and meaning, rewrite, translate, draft or reply (suggestions only). */
  @Post('assist')
  @HttpCode(200)
  async assist(@Body() data: AssistEmailDto, @Req() request: Request) {
    return this.mailAssist.assist(request['user'], data.action, data);
  }


  @Get()
  async fetchAll(
    @Query() query: SearchEmailDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    const user = await this.helperService.extractUserFromRequest(request);
    return instanceToPlain(this.emailService.fetchLocalEmails(query, user, request['user']));
  }

  /** The user's own sender mailboxes; ?all=true: the admin sees everybody's, with the owner. */
  @Get('transporters')
  async fetchTransporters(
    @Req() request: Request,
    @Query('all') all?: string,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.emailService.fetchTransporters(request, all === 'true'));
  }

  @Get('templates')
  async fetchEmailTemplates(
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.emailService.fetchEmailTemplates(request));
  }

  @Get('signs')
  async fetchUsersWithSigns(): Promise<UserWithSign[]> {
    return this.emailService.fetchUsersWithSigns();
  }

  /** Recipients of all letters (the filter «Почты агентов»): admin and manager only, an empty list for others. */
  @Get('agents-email')
  async fetchEmailTo(
    @Query() query: FetchEmailToDto,
    @Req() request: Request,
  ): Promise<PaginationResponseDto<EmailTo[]>> {
    return this.emailService.fetchEmailTo(
      query,
      await this.helperService.extractUserFromRequest(request),
    );
  }

  @Patch('signs')
  async upsertUserSigns(
    @Body() data: CreateSignDto,
    @Req() request: Request,
  ): Promise<UserWithSign> {
    return this.emailService.upsertUserSign(data, request);
  }

  // Remove this
  @Get('mailboxes')
  async fetchMailboxes(): Promise<Record<string, any>> {
    return this.emailService.getEmailFolders();
  }

  @Get('transporters/:id')
  async fetchTransportersById(
    @Req() request: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.emailService.fetchTransporterById(id, request));
  }

  @Get('templates/:id')
  async fetchTemplatesById(
    @Req() request: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      this.emailService.fetchEmailTemplateById(id, request),
    );
  }

  @Get('signs/:user_id')
  async fetchSignByUserId(
    @Param('user_id', ParseIntPipe) user_id: number,
  ): Promise<UserWithSign> {
    return this.emailService.fetchSignByUserId(user_id);
  }

  @Post('transporters')
  async createTransporter(
    @Req() request: Request,
    @Body() data: CreateTransporterDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.emailService.createTransporter(data, request));
  }

  /** «доб.сделку»: a deal with the client of the letters (found or made), the letters in its history. */
  @Post('deals')
  async createDealsFromLetters(
    @Body() data: CreateDealsFromLettersDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return this.emailService.createDealsFromLetters(
      data,
      await this.helperService.extractUserFromRequest(request),
      request['user'],
    );
  }

  /** «доб.контакты»: contacts made from letters; their stored letters point to them. */
  @Post('contacts')
  @HttpCode(200)
  async linkLetterContacts(@Body() data: LinkLetterContactsDto): Promise<{ letters: number; history: number }> {
    return this.emailService.linkLetterContacts(data.user_ids);
  }

  @Post('templates')
  async createTemplate(
    @Req() request: Request,
    @Body() data: CreateTemplateDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      this.emailService.createEmailTemplate(data, request),
    );
  }

  /** «Прочитано» for the user: the letters chosen in Mail, a letter opened in a deal. */
  @Patch('read')
  async markRead(
    @Body() data: MarkReadDto,
    @Req() request: Request,
  ): Promise<{ read: number }> {
    return this.emailService.markRead(
      data.ids,
      await this.helperService.extractUserFromRequest(request),
    );
  }

  @Get(':id')
  async fetchOne(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<Email> {
    return this.emailService.fetchOneLocalEmail(
      id,
      await this.helperService.extractUserFromRequest(request),
      request['user'],
    );
  }

  @Patch(':id/mark-as-spam')
  async markAsSpam(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.emailService.markAsSpam(
      id,
      await this.helperService.extractUserFromRequest(request),
    );
  }

  /** «Не спам»: back to the inbox. */
  @Patch(':id/not-spam')
  async markAsNotSpam(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.emailService.markAsNotSpam(
      id,
      await this.helperService.extractUserFromRequest(request),
    );
  }

  /** «Восстановить» a deleted letter (it is in the Trash mailbox of the server). */
  @Patch(':id/restore')
  async restoreEmail(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.emailService.restoreEmail(
      id,
      await this.helperService.extractUserFromRequest(request),
    );
  }

  /** «Привязать»: a letter of no deal into a deal and / or to a contact. */
  @Post(':id/link')
  @HttpCode(200)
  async linkLetter(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: LinkLetterDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return this.emailService.linkLetter(
      id,
      data,
      await this.helperService.extractUserFromRequest(request),
      request['user'],
    );
  }

  /** Moves the letter to the Trash mailbox (it is no longer erased on the server for good). */
  @Delete(':id')
  async deleteEmail(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.emailService.deleteEmail(
      id,
      await this.helperService.extractUserFromRequest(request),
    );
  }

  @Post()
  @UseInterceptors(
    FilesInterceptor('files', 10, FileService.getMemoryUploadOptions()),
  )
  async sendEmail(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Body() data: SendEmailDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return this.emailService.sendFromForm(
      data,
      await this.helperService.extractUserFromRequest(request),
      files,
      request['user'],
    );
  }

  @Patch('transporters/:id')
  async updateTransporter(
    @Req() request: Request,
    @Body() data: UpdateTransporterDto,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.emailService.updateTransporter(id, data, request);
  }

  @Patch('templates/:id')
  async updateTemplate(
    @Req() request: Request,
    @Body() data: CreateTemplateDto,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.emailService.updateEmailTemplate(id, data, request);
  }

  @Delete('transporters/:id')
  async deleteTransporter(
    @Req() request: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.emailService.deleteTransporter(id, request);
  }

  @Delete('templates/:id')
  async deleteTemplate(
    @Req() request: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.emailService.deleteTemplate(id, request);
  }

  @Delete('signs/:user_id')
  async deleteSign(
    @Param('user_id', ParseIntPipe) user_id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.emailService.deleteUserSign(user_id, request);
  }
}
