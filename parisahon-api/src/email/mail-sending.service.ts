import {
  BadRequestException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import * as nodemailer from 'nodemailer';
import Mail = require('nodemailer/lib/mailer');
import MailComposer = require('nodemailer/lib/mail-composer');
import * as process from 'process';
import { Repository } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { HelperService } from '../helper/helper.service';
import { LoggerService } from '../helper/logger.service';
import { safeHtml } from '../helper/safe-html';
import { User } from '../user/user.entity';
import { SendEmailDto } from './dto/send.email.dto';
import { Email } from './email.entity';
import { EmailCc } from './email_cc.entity';
import { EmailTo } from './email_to.entity';
import {
  MailConnectionService,
  selectedMailbox,
} from './mail-connection.service';
import { MailDealsService } from './mail-deals.service';
import { saveSentFiles, toAttachments } from './mail-files';
import { MailHistoryService } from './mail-history.service';
import { MailSignService } from './mail-sign.service';
import { escapeText, htmlToText, messageIdsIn, textToHtml } from './mail-text';
import { MailTransporterService } from './mail-transporter.service';

export interface SendEmailOptions {
  /** add the sender's signature under the text (triggers: yes; the web form says so with `with_signature`) */
  signature?: boolean;
  /** the letter answered (MailboxService checked that the sender may read it), with its HTML part */
  repliedTo?: Email | null;
  /** extra headers (triggers: Auto-Submitted, so that the client's answering machine does not reply) */
  headers?: Record<string, string>;
  /** the deal of `deal_id`, already checked for the user (EmailService.sendFromForm): the letter goes only there */
  deal?: Deal | null;
}

/**
 * Sends email through the SMTP of the company mail server, from the shared
 * mailbox (EMAIL_DEFAULT_USER) or one of the user's sender accounts, puts a
 * copy into the Sent mailbox, saves it and adds it to the history of deals.
 *
 *  - From carries a name: "Менеджер — Parisa Home <address>" (EMAIL_FROM_NAME, default "Parisa Home").
 *  - A reply has In-Reply-To / References, so the client's mail program keeps the thread, and the
 *    letter answered is quoted under the text and the signature.
 *  - The signature is added here, after the text: in the editor it lost its table, colours and logo.
 *  - From a personal mailbox, replies go to it and to the shared mailbox (Reply-To): the CRM reads
 *    only the shared one (EMAIL_REPLY_TO_SHARED=0 turns this off).
 *  - Attachments together at most EMAIL_MAX_ATTACHMENTS_MB (20); errors of the mail server are told
 *    in words (password, size, address, no answer) instead of "Internal server error".
 *  - The files are written after the server took the letter: a letter that was not sent leaves none.
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
    private connection: MailConnectionService,
    private transporters: MailTransporterService,
    private history: MailHistoryService,
    private mailDeals: MailDealsService,
    private signs: MailSignService,
    private helperService: HelperService,
    private loggerService: LoggerService,
  ) {}

  async sendEmail(
    data: SendEmailDto,
    originatedBy: User,
    files: Array<Express.Multer.File> = [],
    options: SendEmailOptions = { signature: true },
  ): Promise<Email> {
    const shared = process.env.EMAIL_DEFAULT_USER;
    let transporter = this.defaultTransporter;
    let from = shared;

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

    const to = data.to ?? [];
    const cc = data.cc ?? [];
    assertAttachmentsFit(files);

    // The deal the email is written from, even when the recipient is not its contact (unknown: 404
    // before anything is sent). The web form's deal comes checked (rights, not closed); a trigger's as it is.
    const fromDeal = options.deal ?? (data.deal_id
      ? await this.helperService.getById(Deal, +data.deal_id, ['stage'])
      : null);

    const repliedTo = options.repliedTo ?? null;
    const signature = options.signature ? await this.signatureOf(originatedBy) : '';
    const quote = repliedTo && data.quote !== 'false' ? quoteOf(repliedTo) : '';
    const text = String(data.body ?? '');
    const forHistory = text + signature;
    const html = forHistory + quote;

    const references = repliedTo
      ? [...messageIdsIn(repliedTo.reference_ids), ...messageIdsIn(repliedTo.message_id)].slice(-30)
      : [];
    const name = senderName(originatedBy);
    const personal = !!data.transporter_id && String(from).toLowerCase() !== String(shared ?? '').toLowerCase();

    const mailOptions: Mail.Options = {
      from: { name, address: from },
      to,
      cc,
      subject: data.subject,
      html,
      text: htmlToText(html),
      attachments: toAttachments(files),
      // one Message-ID for the letter sent and its copy in Sent: a reply finds its thread by it
      messageId: `<${randomUUID()}@${domainFor(from)}>`,
      ...(repliedTo?.message_id ? { inReplyTo: repliedTo.message_id, references } : {}),
      ...(personal && shared && process.env.EMAIL_REPLY_TO_SHARED !== '0' ? { replyTo: [from, shared] } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    };

    // The letter is built once: the same bytes (Message-ID, Date) go to the client and into Sent, and
    // the same Message-ID is stored, so that the client's reply finds its thread. It used to be built
    // twice, and the copy in Sent and the database had another Message-ID than the letter sent.
    let raw: Buffer;
    let envelope: { from: string | false; to: string[] };
    try {
      const composed = new MailComposer(mailOptions).compile();
      raw = await composed.build();
      envelope = composed.getEnvelope() as { from: string | false; to: string[] };
    } catch (error) {
      this.loggerService.error(`Mail: the letter "${data.subject}" could not be built: ${(error as Error)?.message}`, (error as Error)?.stack);
      throw new BadRequestException('Письмо не удалось собрать: проверьте вложения и адреса');
    }
    if (!envelope?.to?.length) {
      throw new BadRequestException('Укажите адрес получателя');
    }

    try {
      await transporter.sendMail({ envelope: { from: envelope.from || from, to: envelope.to }, raw });
    } catch (error) {
      this.loggerService.error(`SMTP: the letter "${data.subject}" from ${from} was not sent: ${(error as Error)?.message}`, (error as Error)?.stack);
      throw smtpError(error);
    }

    const email = new Email();

    email.from = from;
    email.from_name = name.slice(0, 255);
    email.subject = data.subject;
    email.body = html;
    // the body is the HTML already ('' = nothing to load from the server, see MailSyncService)
    email.html = '';
    email.outgoing = true;
    email.sent_by = originatedBy;
    email.in_reply_to = repliedTo?.message_id ?? null;
    email.reference_ids = references.join(' ') || null;
    email.message_id = String(mailOptions.messageId);
    email.to = to.map((value) => Object.assign(new EmailTo(), { value }));
    email.cc = cc.map((value) => Object.assign(new EmailCc(), { value }));
    email.sent_at = new Date();
    // Since we are the ones sending the email, it will be considered already read for us.
    email.read = true;

    // one deal: the one it is written from, else the thread's, else the newest open deal of the recipients
    const deals = await this.mailDeals.forSent(email, fromDeal);

    // The email is already sent at this point: a failure below must not make the user send it again.
    try {
      email.files = await saveSentFiles(files, originatedBy, deals);
    } catch (error) {
      email.files = [];
      this.loggerService.error('Email was sent, but its files could not be kept', (error as Error)?.stack);
    }

    try {
      await this.copyToSent(raw, email);
    } catch (error) {
      this.loggerService.error(
        'Email was sent, but could not be copied to the Sent mailbox',
        (error as Error)?.stack,
      );
    }

    const saved = await this.emailRepository.save(email);
    await this.history.addSent(saved, deals, originatedBy, forHistory);
    return saved;
  }

  /**
   * Appends the sent message to the Sent mailbox and records where it lies
   * (uid, mailbox, UIDVALIDITY), so that sync knows the copy.
   */
  private async copyToSent(raw: Buffer, email: Email): Promise<void> {
    const sent = this.connection.mailboxes.sent;

    await this.connection.withMailbox(sent, async (imap) => {
      const result = await imap.append(sent, raw, ['Seen']);

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

  /** The sender's signature (their own, else the company one with their name), cleaned; '' when none. */
  private async signatureOf(user: User): Promise<string> {
    if (!user?.id) return '';
    try {
      const sign = (await this.signs.fetchSignByUserId(user.id))?.sign;
      return sign ? `<br><div class="crm-signature">${safeHtml(sign)}</div>` : '';
    } catch {
      return '';
    }
  }
}

/** SMTP of the company mail server (EMAIL_HOST, EMAIL_SMTP_PORT, TLS) as `user`. */
export function smtp(user: string, pass: string): nodemailer.Transporter {
  return nodemailer.createTransport({
    auth: { user, pass },
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_SMTP_PORT) || 465,
    secure: true,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
}

/** "Менеджер — Parisa Home": the name the client sees in From. */
function senderName(user: User | null | undefined): string {
  const brand = (process.env.EMAIL_FROM_NAME ?? 'Parisa Home').trim();
  const person = String(user?.username ?? '').trim();
  return [person, brand].filter(Boolean).filter((s, i, all) => all.indexOf(s) === i).join(' — ') || brand;
}

function domainFor(address: string | null | undefined): string {
  const at = String(address ?? '').lastIndexOf('@');
  return at >= 0 ? String(address).slice(at + 1) : 'parisahome.com';
}

/** The letter answered, under the reply: "<date>, <who> написал(а):" and its text. */
function quoteOf(letter: Email): string {
  const when = letter.sent_at ? new Date(letter.sent_at).toLocaleString('ru-RU') : '';
  const who = letter.from_name ? `${letter.from_name} <${letter.from ?? ''}>` : letter.from ?? '';
  const text = letter.html ? htmlToText(letter.html) : letter.outgoing ? htmlToText(letter.body) : String(letter.body ?? '');
  return (
    `<br><div class="crm-quote"><div>${escapeText([when, who].filter(Boolean).join(', '))} написал(а):</div>` +
    `<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${textToHtml(text.slice(0, 20000))}</blockquote></div>`
  );
}

function assertAttachmentsFit(files: Array<Express.Multer.File>): void {
  const max = Number(process.env.EMAIL_MAX_ATTACHMENTS_MB ?? 20) || 20;
  const total = files.reduce((sum, file) => sum + (file.size ?? file.buffer?.length ?? 0), 0);
  if (total > max * 1024 * 1024) {
    throw new BadRequestException(
      `Вложения вместе ${(total / 1024 / 1024).toFixed(1)} МБ, почтовый сервер примет не больше ${max} МБ: уменьшите или уберите файлы.`,
    );
  }
}

/** An error of the mail server in words the manager can act on. */
export function smtpError(error: any): HttpException {
  const code = String(error?.code ?? '');
  const status = Number(error?.responseCode) || 0;
  const response = String(error?.response ?? error?.message ?? '');
  const rejected: string[] = Array.isArray(error?.rejected) ? error.rejected.map(String) : [];

  if (code === 'EAUTH' || status === 535 || status === 534 || status === 530) {
    return new BadRequestException(
      'Почтовый сервер не принял логин или пароль ящика. Проверьте пароль ящика в «Почта → Настройки» (после смены пароля почты его нужно ввести и здесь).',
    );
  }
  if (status === 552 || /size|too (big|large)|exceed/i.test(response)) {
    return new BadRequestException('Письмо слишком большое для почтового сервера: уменьшите или уберите вложения.');
  }
  if (code === 'EENVELOPE' || [501, 550, 551, 553, 554].includes(status)) {
    const who = rejected.length ? `: ${rejected.join(', ')}` : '';
    return new BadRequestException(`Почтовый сервер отклонил адрес получателя${who}. Проверьте адрес.`);
  }
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(code) || status === 421) {
    // 400, not 503: a client that retries 5xx by itself would send the letter twice
    return new BadRequestException('Почтовый сервер не отвечает. Попробуйте отправить письмо ещё раз через несколько минут.');
  }
  return new BadRequestException(`Письмо не отправлено: ${response.slice(0, 200) || 'ошибка почтового сервера'}`);
}
