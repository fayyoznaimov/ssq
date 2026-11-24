import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { Access } from '../auth/access';
import { AuthUser } from '../auth/auth.guard';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { HelperService } from '../helper/helper.service';
import { User } from '../user/user.entity';
import { CreateDealsFromLettersDto, LinkLetterDto } from './dto/create.deals.dto';
import { CreateSignDto } from './dto/create.sign.dto';
import { CreateTemplateDto } from './dto/create.template.dto';
import { CreateTransporterDto } from './dto/create.transporter.dto';
import { FetchEmailToDto } from './dto/fetch.email.to.dto';
import { SearchEmailDto } from './dto/search.email.dto';
import { SendEmailDto } from './dto/send.email.dto';
import { Email } from './email.entity';
import { DealFromLetters, MailDealsService } from './mail-deals.service';
import { MailboxService, toAuthUser } from './mailbox.service';
import { MailSendingService, SendEmailOptions } from './mail-sending.service';
import { MailSignService } from './mail-sign.service';
import { MailSyncService, MailSyncStatus } from './mail-sync.service';
import { MailTemplateService } from './mail-template.service';
import { MailTransporterService } from './mail-transporter.service';

/**
 * The mail module as EmailController and other modules (triggers send through
 * sendEmail) see it. The work is done by:
 *  - MailConnectionService: the IMAP connection to the company mail server;
 *  - MailSyncService: copying its mailboxes into the database;
 *  - MailDealsService: which deals a letter belongs to, deals made from letters;
 *  - MailHistoryService: letters in the history of deals;
 *  - MailboxService: listing, opening, spam, deleting, who sees what;
 *  - MailSendingService: SMTP, the copy in Sent, deal history;
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
    private mailDeals: MailDealsService,
    private transporters: MailTransporterService,
    private templates: MailTemplateService,
    private signs: MailSignService,
    private helperService: HelperService,
  ) {}

  /**
   * Pulls new mail from the server, then answers like GET /emails, with `sync`: how the copying
   * went (a mailbox that failed, letters that could not be loaded, the last successful run).
   */
  async syncEmailsFromAllMailBoxes(
    query: SearchEmailDto,
    request: Request,
  ): Promise<PaginationResponseDto<Email[]> & { sync: MailSyncStatus }> {
    const user = await this.helperService.extractUserFromRequest(request);

    // the mail server may be away or not set up for this user: the letters already stored are shown anyway
    try {
      await this.sync.syncAllMailboxes();
    } catch (error) {
      this.logger.warn(`mail sync: ${(error as Error)?.message ?? error}`);
    }

    const page = await this.mailbox.fetchLocalEmails(query, user, request['user']);
    return Object.assign(page, { sync: this.sync.status() });
  }

  syncStatus(): MailSyncStatus {
    return this.sync.status();
  }

  // Mailbox

  fetchLocalEmails(query: SearchEmailDto, user: User = null, authUser: AuthUser = null) {
    return this.mailbox.fetchLocalEmails(query, user, authUser);
  }

  fetchOneLocalEmail(id: number, user: User, authUser: AuthUser = null) {
    return this.mailbox.fetchOneLocalEmail(id, user, authUser);
  }

  markRead(ids: number[], user: User) {
    return this.mailbox.markRead(ids, user);
  }

  markAsSpam(id: number, user: User) {
    return this.mailbox.markAsSpam(id, user);
  }

  markAsNotSpam(id: number, user: User) {
    return this.mailbox.markAsNotSpam(id, user);
  }

  deleteEmail(id: number, user: User) {
    return this.mailbox.deleteEmail(id, user);
  }

  restoreEmail(id: number, user: User) {
    return this.mailbox.restoreEmail(id, user);
  }

  async getEmailFolders() {
    try {
      return await this.mailbox.getEmailFolders();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadRequestException('Почтовый сервер недоступен или почта не настроена');
    }
  }

  fetchEmailTo(query: FetchEmailToDto, user: User = null) {
    return this.mailbox.fetchEmailTo(query, user);
  }

  /** «доб.сделку»: deals with the clients of the letters, the letters in their history. */
  async createDealsFromLetters(
    data: CreateDealsFromLettersDto,
    user: User,
    authUser: AuthUser,
  ): Promise<DealFromLetters[]> {
    const letters = await this.mailbox.accessibleLetters(data.email_ids, user);
    return this.mailDeals.createFromLetters(letters, data, user, authUser);
  }

  /**
   * «Привязать» a letter of no deal (Mail, «Неразобранные»): into a deal and / or to a contact; the
   * other stored letters of the address follow the contact.
   */
  async linkLetter(id: number, data: LinkLetterDto, user: User, authUser: AuthUser) {
    if (!data.deal_id && !data.contact_id) throw new BadRequestException('Выберите сделку или контакт');
    const [letter] = await this.mailbox.accessibleLetters([id], user);
    return this.mailDeals.linkLetter(letter, data, authUser ?? toAuthUser(user));
  }

  /** «доб.контакты»: the stored letters of the new contacts point to them (and go into their open deals). */
  linkLetterContacts(userIds: number[]) {
    return this.mailDeals.linkContacts(userIds);
  }

  // Sending

  /**
   * Sending for other modules (triggers): the sender's signature is added under the text.
   * The web form goes through sendFromForm.
   */
  sendEmail(
    data: SendEmailDto,
    originatedBy: User,
    files: Array<Express.Multer.File> = [],
    options: SendEmailOptions = { signature: true },
  ) {
    return this.sending.sendEmail(data, originatedBy, files, options);
  }

  /**
   * POST /emails. The signature only when the form asks for it (with_signature=true): the web
   * client of before put it into the text itself. The letter answered must be one the user may read.
   */
  async sendFromForm(
    data: SendEmailDto,
    originatedBy: User,
    files: Array<Express.Multer.File> = [],
    authUser: AuthUser | null = null,
  ): Promise<{ id: number; message_id: string }> {
    const repliedTo = data.reply_to_email_id
      ? await this.mailbox.accessibleLetter(+data.reply_to_email_id, originatedBy)
      : null;
    // the deal written from: one the user may change and not closed (an agent used to write into
    // the history of colleagues' and closed deals)
    const deal = data.deal_id
      ? await this.mailDeals.writableDeal(+data.deal_id, new Access(authUser ?? toAuthUser(originatedBy)))
      : null;
    const saved = await this.sending.sendEmail(data, originatedBy, files, {
      signature: data.with_signature === 'true',
      repliedTo,
      deal,
    });
    return { id: saved.id, message_id: saved.message_id };
  }

  // Sender accounts

  fetchTransporters(request: Request, all = false) {
    return this.transporters.fetchTransporters(request, all);
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
