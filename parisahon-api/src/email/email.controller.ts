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
    return instanceToPlain(this.emailService.fetchLocalEmails(query, user));
  }

  @Get('transporters')
  async fetchTransporters(
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.emailService.fetchTransporters(request));
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

  @Get('agents-email')
  async fetchEmailTo(
    @Query() query: FetchEmailToDto,
  ): Promise<PaginationResponseDto<EmailTo[]>> {
    return this.emailService.fetchEmailTo(query);
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

  @Post('templates')
  async createTemplate(
    @Req() request: Request,
    @Body() data: CreateTemplateDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      this.emailService.createEmailTemplate(data, request),
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
  ): Promise<void> {
    return this.emailService.sendEmail(
      data,
      await this.helperService.extractUserFromRequest(request),
      files,
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
