import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { HelperService } from '../helper/helper.service';
import { User } from '../user/user.entity';
import { CreateSignDto } from './dto/create.sign.dto';
import { CreateTemplateDto } from './dto/create.template.dto';
import { CreateTransporterDto } from './dto/create.transporter.dto';
import { FetchEmailToDto } from './dto/fetch.email.to.dto';
import { SearchEmailDto } from './dto/search.email.dto';
import { SendEmailDto } from './dto/send.email.dto';
import { Email } from './email.entity';
import { MailboxService } from './mailbox.service';
import { MailSendingService } from './mail-sending.service';
import { MailSignService } from './mail-sign.service';
import { MailSyncService } from './mail-sync.service';
import { MailTemplateService } from './mail-template.service';
import { MailTransporterService } from './mail-transporter.service';

/**
 * The mail module as EmailController and other modules (triggers send through
 * sendEmail) see it. The work is done by:
 *  - MailConnectionService: the IMAP connection to the company mail server;
 *  - MailSyncService: copying its mailboxes into the database;
 *  - MailboxService: listing, opening, spam, deleting, who sees what;
 *  - MailSendingService: SMTP, the copy in Sent, deal history (MailHistoryService);
 *  - MailTransporterService, MailTemplateService, MailSignService: the user's
 *    sender accounts, templates and signature.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private sync: MailSyncService,
    private mailbox: MailboxService,
    private sending: MailSendingService,
    private transporters: MailTransporterService,
    private templates: MailTemplateService,
    private signs: MailSignService,
    private helperService: HelperService,
  ) {}

  /** Pulls new mail from the server, then answers like GET /emails. */
  async syncEmailsFromAllMailBoxes(
    query: SearchEmailDto,
    request: Request,
  ): Promise<PaginationResponseDto<Email[]>> {
    const user = await this.helperService.extractUserFromRequest(request);

    // the mail server may be away or not set up for this user: the letters already stored are shown anyway
    try {
      await this.sync.syncAllMailboxes();
    } catch (error) {
      this.logger.warn(`mail sync: ${(error as Error)?.message ?? error}`);
    }

    return this.mailbox.fetchLocalEmails(query, user);
  }

  // Mailbox

  fetchLocalEmails(query: SearchEmailDto, user: User = null) {
    return this.mailbox.fetchLocalEmails(query, user);
  }

  fetchOneLocalEmail(id: number, user: User) {
    return this.mailbox.fetchOneLocalEmail(id, user);
  }

  markAsSpam(id: number, user: User) {
    return this.mailbox.markAsSpam(id, user);
  }

  deleteEmail(id: number, user: User) {
    return this.mailbox.deleteEmail(id, user);
  }

  async getEmailFolders() {
    try {
      return await this.mailbox.getEmailFolders();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadRequestException('Почтовый сервер недоступен или почта не настроена');
    }
  }

  fetchEmailTo(query: FetchEmailToDto) {
    return this.mailbox.fetchEmailTo(query);
  }

  // Sending

  sendEmail(
    data: SendEmailDto,
    originatedBy: User,
    files: Array<Express.Multer.File> = [],
  ) {
    return this.sending.sendEmail(data, originatedBy, files);
  }

  // Sender accounts

  fetchTransporters(request: Request) {
    return this.transporters.fetchTransporters(request);
  }

  fetchTransporterById(id: number, request: Request) {
    return this.transporters.fetchTransporterById(id, request);
  }

  createTransporter(data: CreateTransporterDto, request: Request) {
    return this.transporters.createTransporter(data, request);
  }

  updateTransporter(id: number, data: CreateTransporterDto, request: Request) {
    return this.transporters.updateTransporter(id, data, request);
  }

  deleteTransporter(id: number, request: Request) {
    return this.transporters.deleteTransporter(id, request);
  }

  // Templates

  fetchEmailTemplates(request: Request) {
    return this.templates.fetchEmailTemplates(request);
  }

  fetchEmailTemplateById(id: number, request: Request) {
    return this.templates.fetchEmailTemplateById(id, request);
  }

  createEmailTemplate(data: CreateTemplateDto, request: Request) {
    return this.templates.createEmailTemplate(data, request);
  }

  updateEmailTemplate(id: number, data: CreateTemplateDto, request: Request) {
    return this.templates.updateEmailTemplate(id, data, request);
  }

  deleteTemplate(id: number, request: Request) {
    return this.templates.deleteTemplate(id, request);
  }

  // Signatures

  fetchUsersWithSigns() {
    return this.signs.fetchUsersWithSigns();
  }

  fetchSignByUserId(user_id: number) {
    return this.signs.fetchSignByUserId(user_id);
  }

  upsertUserSign(data: CreateSignDto, request: Request) {
    return this.signs.upsertUserSign(data, request);
  }

  deleteUserSign(user_id: number, request: Request) {
    return this.signs.deleteUserSign(user_id, request);
  }
}
