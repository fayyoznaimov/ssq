import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as nodemailer from 'nodemailer';
import Mail = require('nodemailer/lib/mailer');
import MailComposer = require('nodemailer/lib/mail-composer');
import * as process from 'process';
import { Repository } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { HelperService } from '../helper/helper.service';
import { LoggerService } from '../helper/logger.service';
import { User } from '../user/user.entity';
import { SendEmailDto } from './dto/send.email.dto';
import { Email } from './email.entity';
import { EmailCc } from './email_cc.entity';
import { EmailTo } from './email_to.entity';
import {
  MailConnectionService,
  selectedMailbox,
} from './mail-connection.service';
import { saveSentFiles, toAttachments } from './mail-files';
import { MailHistoryService } from './mail-history.service';
import { MailTransporterService } from './mail-transporter.service';

/**
 * Sends email through the SMTP of the company mail server, from the shared
 * mailbox (EMAIL_DEFAULT_USER) or one of the user's sender accounts, puts a
 * copy into the Sent mailbox, saves it and adds it to the history of deals.
 */
@Injectable()
export class MailSendingService {
  private defaultTransporter = smtp(
    process.env.EMAIL_DEFAULT_USER,
    process.env.EMAIL_DEFAULT_PASSWORD,
  );

  constructor(
    @InjectRepository(Email)
    private emailRepository: Repository<Email>,
    @InjectRepository(Deal)
    private dealRepository: Repository<Deal>,
    private connection: MailConnectionService,
    private transporters: MailTransporterService,
    private history: MailHistoryService,
    private helperService: HelperService,
    private loggerService: LoggerService,
  ) {}

  async sendEmail(
    data: SendEmailDto,
    originatedBy: User,
    files: Array<Express.Multer.File> = [],
  ): Promise<void> {
    let transporter = this.defaultTransporter;
    let from = process.env.EMAIL_DEFAULT_USER;

    if (data.transporter_id) {
      const account = await this.transporters.fetchOwn(
        +data.transporter_id,
        originatedBy?.id,
      );
      from = account.email;
      transporter = smtp(
        account.email,
        this.transporters.decryptPassword(account.password),
      );
    }

    const email = new Email();

    email.from = from;
    email.subject = data.subject;
    email.body = data.body;
    email.outgoing = true;
    email.sent_by = originatedBy;
    email.to = (data.to ?? []).map((value) =>
      Object.assign(new EmailTo(), { value }),
    );
    email.cc = (data.cc ?? []).map((value) =>
      Object.assign(new EmailCc(), { value }),
    );
    email.sent_at = new Date();
    // Since we are the ones sending the email, it will be considered already read for us.
    email.read = true;

    const deals = await this.fetchConnectedDeals(data);

    // The deal the email is written from, even when the recipient is not its contact
    if (data.deal_id) {
      const deal = await this.helperService.getById(Deal, +data.deal_id);
      if (!deals.some((connected) => connected.id === deal.id)) {
        deals.push(deal);
      }
    }

    email.files = await saveSentFiles(files, originatedBy, deals);

    const mailOptions: Mail.Options = {
      from: from,
      to: data.to,
      cc: data.cc,
      subject: data.subject,
      html: data.body,
      attachments: toAttachments(files),
    };

    await transporter.sendMail(mailOptions);

    // The email is already sent at this point. Failing the request because the
    // copy to the Sent folder did not work makes the user send it a second time.
    try {
      await this.copyToSent(mailOptions, email);
    } catch (error) {
      this.loggerService.error(
        'Email was sent, but could not be copied to the Sent mailbox',
        error.stack,
      );
    }

    this.history.addSent(
      await this.emailRepository.save(email),
      deals,
      originatedBy,
    );
  }

  /**
   * Appends the sent message to the Sent mailbox and records where it lies
   * (uid, mailbox, UIDVALIDITY, Message-ID), so that sync knows the copy.
   */
  private async copyToSent(content: Mail.Options, email: Email): Promise<void> {
    const sent = this.connection.mailboxes.sent;

    await this.connection.withMailbox(sent, async (imap) => {
      const compiled = new MailComposer(content).compile();
      // Generated here, so the stored copy can be matched with the server later
      email.message_id = compiled.messageId()?.slice(0, 998) ?? null;

      const result = await imap.append(sent, await compiled.build(), ['Seen']);

      // The uid belongs to the Sent mailbox. Without recording that, the entity
      // defaults to INBOX: sync then skips the INBOX email with the same uid
      // and saves this one a second time from the Sent mailbox.
      email.email_id = result.uid;
      email.from_mailbox = sent;
      email.uidvalidity = String(
        result.uidValidity ?? selectedMailbox(imap).uidValidity,
      );
    });
  }

  /** Open deals whose contacts are among the recipients. */
  private async fetchConnectedDeals(data: SendEmailDto): Promise<Deal[]> {
    if (!data.cc) {
      data.cc = [];
    }
    const emails = [...data.to, ...data.cc].map((email) => email.toLowerCase());

    return this.dealRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.stage', 't1')
      .leftJoinAndSelect('t0.ctr_agents', 't2')
      .where('t1.name NOT IN (:...closed_stages)', {
        closed_stages: [
          process.env.DEAL_STAGE_CLOSED,
          process.env.DEAL_STAGE_CLOSED_NOT_REALIZED,
        ],
      })
      .andWhere('LOWER(t2.email) IN (:...emails)', { emails: emails })
      .getMany();
  }
}

/** SMTP of the company mail server (EMAIL_HOST, EMAIL_SMTP_PORT, TLS) as `user`. */
function smtp(user: string, pass: string): nodemailer.Transporter {
  return nodemailer.createTransport({
    auth: { user, pass },
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_SMTP_PORT) || 465,
    secure: true,
  });
}
