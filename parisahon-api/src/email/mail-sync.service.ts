import {
  BadRequestException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FetchMessageObject, ImapFlow, SearchObject } from 'imapflow';
import { AddressObject, simpleParser } from 'mailparser';
import * as process from 'process';
import { Repository } from 'typeorm';
import { LoggerService } from '../helper/logger.service';
import { User } from '../user/user.entity';
import { Email } from './email.entity';
import { EmailCc } from './email_cc.entity';
import { EmailTo } from './email_to.entity';
import {
  MailConnectionService,
  selectedMailbox,
} from './mail-connection.service';
import { saveReceivedAttachment } from './mail-files';
import { MailHistoryService } from './mail-history.service';

/**
 * Copies the mailboxes of the company mail server (EMAIL_SENT/SPAM/TRASH/
 * MAIN_MAILBOX) into the database: on GET /emails/sync and in the background
 * every EMAIL_SYNC_INTERVAL_MINUTES (3; 0 turns it off).
 */
@Injectable()
export class MailSyncService implements OnModuleInit, OnModuleDestroy {
  private syncRunning: Promise<void> | null = null;
  private syncTimer: NodeJS.Timeout;

  constructor(
    @InjectRepository(Email)
    private emailRepository: Repository<Email>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private connection: MailConnectionService,
    private history: MailHistoryService,
    private loggerService: LoggerService,
  ) {}

  onModuleInit(): void {
    const minutes = Number(process.env.EMAIL_SYNC_INTERVAL_MINUTES ?? 3);
    if (minutes > 0) {
      this.syncTimer = setInterval(() => {
        this.syncAllMailboxes().catch((error) =>
          this.loggerService.error('Background email sync failed', error.stack),
        );
      }, minutes * 60_000);
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.syncTimer);
  }

  /**
   * Used by both the endpoint and the background timer. Only one sync runs at
   * a time: two concurrent runs would both save the same new emails.
   */
  syncAllMailboxes(): Promise<void> {
    if (!this.syncRunning) {
      this.syncRunning = this.doSyncAllMailboxes().finally(() => {
        this.syncRunning = null;
      });
    }

    return this.syncRunning;
  }

  private async doSyncAllMailboxes(): Promise<void> {
    const imap = await this.connection.client();
    const existing = (await imap.list()).map((mailbox) => mailbox.path);
    const { inbox, sent, spam, trash } = this.connection.mailboxes;
    // INBOX last: the connection keeps the last synced mailbox selected, and a
    // mailbox that is selected cannot be deleted or renamed by another client.
    const used = [sent, spam, trash, inbox];

    // Spam and trash are known by name only: a renamed mailbox breaks them.
    const missing = used.filter((mailbox) => !existing.includes(mailbox));
    if (missing.length > 0) {
      throw new BadRequestException(
        `IMAP Server is missing mailboxes: ${missing.join(', ')}. Please alert the dev team!`,
      );
    }

    for (const mailbox of used) {
      await this.syncMailbox(mailbox);
    }
  }

  /**
   * The hosting does not allow custom IMAP flags that would mark what the CRM
   * already has, so dates limit what is looked at, and of that only the uids
   * not stored yet are downloaded.
   *
   * Messages are downloaded and saved in batches of EMAIL_SYNC_BATCH (50): the
   * first sync of a big mailbox used to parse every message into memory first.
   */
  private async syncMailbox(mailbox: string): Promise<void> {
    await this.connection.withMailbox(mailbox, async (imap) => {
      const uidValidity = String(selectedMailbox(imap).uidValidity);
      await this.reconcileUidValidity(imap, mailbox, uidValidity);

      const latestSyncDate = await this.getLatestSyncDate(mailbox);
      const searchObject: SearchObject = { all: true };

      if (latestSyncDate) {
        /**
         * sent_at comes from the Date header, which the sender controls, while
         * SINCE works on the arrival date. So a future-dated email must not
         * hide everything that arrives after it, and a day of overlap covers
         * emails whose header date is ahead of their arrival.
         */
        const day = 24 * 60 * 60 * 1000;
        searchObject['since'] = new Date(
          Math.min(latestSyncDate.getTime(), Date.now()) - day,
        );
      }

      // UIDs of emails that arrived since the last synchronized date
      const foundUids = await imap.search(searchObject, { uid: true });
      if (!foundUids || foundUids.length === 0) {
        return;
      }

      const known = await this.getSynchronizedUids(foundUids, mailbox);
      const newUids = foundUids
        .filter((uid) => !known.has(uid))
        .sort((a, b) => a - b);

      for (const batch of chunks(newUids, syncBatchSize())) {
        await this.syncBatch(imap, mailbox, uidValidity, batch);
      }
    });
  }

  /** Downloads, saves and announces one batch of new messages of a mailbox. */
  private async syncBatch(
    imap: ImapFlow,
    mailbox: string,
    uidValidity: string,
    uids: number[],
  ): Promise<void> {
    const messages = imap.fetch(
      uids,
      { source: true, flags: true, uid: true },
      { uid: true },
    );
    const newEmails: Email[] = [];

    for await (const message of messages) {
      const email = await this.toEmail(message, mailbox);
      email.uidvalidity = uidValidity;

      newEmails.push(email);
    }

    if (newEmails.length > 0) {
      await this.history.addReceived(
        await this.emailRepository.save(newEmails),
      );
    }
  }

  /** A message of the server as an unsaved Email; its attachments are written to disk. */
  private async toEmail(
    message: FetchMessageObject,
    mailbox: string,
  ): Promise<Email> {
    const parsed = await simpleParser(message.source);
    const email = new Email();

    email.body = parsed.text;
    email.from = parsed.from?.value[0].address;
    email.subject = parsed.subject;
    email.email_id = Number(message.uid);
    email.cc = addresses(parsed.cc, EmailCc);
    email.to = addresses(parsed.to, EmailTo);
    email.sent_at = parsed.date;
    email.thread_id = message.threadId;
    email.message_id = parsed.messageId?.slice(0, 998) ?? null;
    email.from_mailbox = mailbox;
    if (email.from) {
      // Sent from a company address
      email.outgoing = email.from.includes('@parisahome.com');
    }

    if (message.flags && message.flags.has('\\Seen')) {
      email.read = true;
    }

    if (mailbox === this.connection.mailboxes.spam) {
      email.is_spam = true;
    } else if (mailbox === this.connection.mailboxes.trash) {
      email.deleted_at = new Date();
    }

    // The sender as a contact (ctr_agent) with their open deals, for deal history
    const sender = await this.userRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.linked_deals', 't1')
      .where('t1.closed_at IS NULL')
      .andWhere('LOWER(t0.email) = LOWER(:email)', { email: email.from })
      .getOne();

    email.from_user = sender;
    email.files = [];

    for (const attachment of parsed.attachments || []) {
      if (attachment) {
        email.files.push(
          await saveReceivedAttachment(
            attachment.content,
            attachment.filename ?? '',
            attachment.size,
            sender,
          ),
        );
      }
    }

    return email;
  }

  /**
   * UIDVALIDITY of a mailbox changes when the server renumbers it (the mailbox
   * was re-created, the hosting moved). Every stored uid of that mailbox is
   * then wrong: flags would go to other messages and every message would be
   * saved a second time. So the stored copies are matched with the server
   * again by Message-ID (older rows: by sender, subject and date) and get the
   * new uid; copies that are no longer on the server keep only their local
   * part (email_id = NULL).
   *
   * Rows saved before UIDVALIDITY was tracked (NULL) adopt the current value.
   */
  private async reconcileUidValidity(
    imap: ImapFlow,
    mailbox: string,
    current: string,
  ): Promise<void> {
    const stored = await this.emailRepository
      .createQueryBuilder('t0')
      .select('t0.uidvalidity', 'uidvalidity')
      .distinct(true)
      .where('t0.from_mailbox = :mailbox', { mailbox })
      .andWhere('t0.uidvalidity IS NOT NULL')
      .withDeleted()
      .getRawMany<{ uidvalidity: string }>();
    const known = stored.map((row) => String(row.uidvalidity));

    if (known.some((value) => value !== current)) {
      this.loggerService.error(
        `IMAP: UIDVALIDITY of ${mailbox} changed (${known.join(', ')} -> ${current}), re-matching the local copies`,
        '',
      );
      await this.remapMailbox(imap, mailbox, current);
    }

    await this.emailRepository
      .createQueryBuilder()
      .update(Email)
      .set({ uidvalidity: current })
      .where('from_mailbox = :mailbox', { mailbox })
      .andWhere('uidvalidity IS NULL')
      .execute();
  }

  private async remapMailbox(
    imap: ImapFlow,
    mailbox: string,
    current: string,
  ): Promise<void> {
    // Index of what the server holds now; a few fields per message, not the bodies
    const byMessageId = new Map<string, number>();
    const byFallback = new Map<string, number>();

    // "1:*" is not a valid range for an empty mailbox
    const envelopes = selectedMailbox(imap).exists
      ? imap.fetch('1:*', { uid: true, envelope: true }, { uid: true })
      : [];
    for await (const message of envelopes) {
      const envelope = message.envelope;
      const messageId = normalizeMessageId(envelope?.messageId);
      if (messageId) {
        byMessageId.set(messageId, message.uid);
      }
      byFallback.set(
        fallbackKey(
          envelope?.from?.[0]?.address,
          envelope?.subject,
          envelope?.date,
        ),
        message.uid,
      );
    }

    const rows = await this.emailRepository
      .createQueryBuilder('t0')
      .select([
        't0.id',
        't0.email_id',
        't0.message_id',
        't0.from',
        't0.subject',
        't0.sent_at',
      ])
      .where('t0.from_mailbox = :mailbox', { mailbox })
      .andWhere('(t0.uidvalidity IS NULL OR t0.uidvalidity != :current)', {
        current,
      })
      .withDeleted()
      .getMany();

    let matched = 0;
    for (const row of rows) {
      const uid =
        byMessageId.get(normalizeMessageId(row.message_id)) ??
        byFallback.get(fallbackKey(row.from, row.subject, row.sent_at)) ??
        null;

      if (uid !== null) {
        matched++;
      }

      await this.emailRepository.update(row.id, {
        email_id: uid,
        uidvalidity: current,
      });
    }

    this.loggerService.error(
      `IMAP: ${mailbox} re-matched: ${matched} of ${rows.length} local copies found on the server`,
      '',
    );
  }

  /** The newest stored date of the mailbox, soft-deleted rows included. */
  private async getLatestSyncDate(mailbox: string): Promise<Date | null> {
    const latestEmail = await this.emailRepository
      .createQueryBuilder('t0')
      .orderBy('t0.sent_at', 'DESC')
      .where('t0.from_mailbox = :mailbox', { mailbox })
      .withDeleted()
      .getOne();

    return latestEmail?.sent_at ?? null;
  }

  /**
   * Which of the uids are stored already. UIDs are unique only inside one
   * mailbox; soft-deleted rows count, so deleted emails are not saved again.
   */
  private async getSynchronizedUids(
    uids: number[],
    mailbox: string,
  ): Promise<Set<number>> {
    const known = new Set<number>();

    // The first sync of a big mailbox asks about every uid at once
    for (const batch of chunks(uids, 1000)) {
      const emails = await this.emailRepository
        .createQueryBuilder('t0')
        .select('t0.email_id')
        .where('t0.from_mailbox = :mailbox', { mailbox })
        .andWhere('t0.email_id IN (:...uids)', { uids: batch })
        .withDeleted()
        .getRawMany();

      emails.forEach((email) => known.add(Number(email['t0_email_id'])));
    }

    return known;
  }
}

function syncBatchSize(): number {
  const size = Number(process.env.EMAIL_SYNC_BATCH ?? 50);
  return Number.isInteger(size) && size > 0 ? size : 50;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/** To/Cc rows of a parsed header: one row per address group, as written. */
function addresses<T extends EmailTo | EmailCc>(
  header: AddressObject | AddressObject[] | undefined,
  Row: new () => T,
): T[] {
  const groups = Array.isArray(header) ? header : header ? [header] : [];

  return groups.map((group) => {
    const row = new Row();
    row.value = group.text;
    return row;
  });
}

function normalizeMessageId(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^<|>$/g, '').toLowerCase();
}

/** For rows without a Message-ID: sender, subject and the Date header to the second. */
function fallbackKey(
  from: string | null | undefined,
  subject: string | null | undefined,
  date: Date | string | null | undefined,
): string {
  const time = date ? Math.floor(new Date(date).getTime() / 1000) : 0;
  return `${(from ?? '').toLowerCase()}|${subject ?? ''}|${time}`;
}
