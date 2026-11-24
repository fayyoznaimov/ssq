import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FetchMessageObject, ImapFlow, SearchObject } from 'imapflow';
import { AddressObject, simpleParser } from 'mailparser';
import * as process from 'process';
import { DataSource, Repository } from 'typeorm';
import { TelegramBotApi } from '../bot/telegram-bot.api';
import { LoggerService } from '../helper/logger.service';
import { RoleEnum, User } from '../user/user.entity';
import { Email } from './email.entity';
import { EmailCc } from './email_cc.entity';
import { EmailTo } from './email_to.entity';
import {
  MailConnectionService,
  selectedMailbox,
} from './mail-connection.service';
import { PendingAttachment, receivedAttachment, removeWritten, writeAttachments } from './mail-files';
import { MailDealsService } from './mail-deals.service';
import { HistoryItem, MailHistoryService } from './mail-history.service';
import { addressesIn, clip, htmlToText, messageIdOf, messageIdsIn, noNul, safeFileName, splitQuote } from './mail-text';
import { AuditJournal } from '../audit/audit-journal';

/** What the mail page and the admin see about the background copying of the mailboxes. */
export interface MailSyncStatus {
  ok: boolean;
  running: boolean;
  last_run_at: Date | null;
  /** the last run in which every mailbox was copied without an error */
  last_success_at: Date | null;
  /** mailboxes that failed in the last run */
  errors: { mailbox: string; message: string }[];
  /** letters that failed and are tried again on the next runs */
  failing: { mailbox: string; uid: number; attempts: number; error: string }[];
  /** letters that failed MAX_ATTEMPTS times: saved without their content, the original stays on the server */
  skipped: { mailbox: string; uid: number; subject: string | null; error: string; at: Date }[];
}

/** A letter that failed this many runs is saved as a stub (headers only) and not fetched again. */
const MAX_ATTEMPTS = 3;
/** Larger HTML parts lose their embedded images (data: URLs); even larger ones are not kept. */
const MAX_HTML = 1_500_000;
/** Older letters whose HTML part is read again per mailbox and run. */
const HTML_BACKFILL_BATCH = 25;

/**
 * Copies the mailboxes of the company mail server (EMAIL_SENT/SPAM/TRASH/
 * MAIN_MAILBOX) into the database: on GET /emails/sync and in the background
 * every EMAIL_SYNC_INTERVAL_MINUTES (3; 0 turns it off).
 *
 * One bad letter must not stop the mail: every letter is parsed and saved on its own (a failure is
 * retried on the next runs, after MAX_ATTEMPTS the letter is saved without its content), and a
 * mailbox that fails does not stop the others. The state of the last run is kept for the mail page
 * (GET /emails/sync-status) and told to the admins in the CRM bot (EMAIL_SYNC_ALERT_HOURS, 6; 0 off).
 */
@Injectable()
export class MailSyncService implements OnModuleInit, OnModuleDestroy {
  private syncRunning: Promise<void> | null = null;
  private syncTimer: NodeJS.Timeout;
  /** `mailbox|uidvalidity|uid` -> failed attempts */
  private failures = new Map<string, { attempts: number; error: string }>();
  private state: Omit<MailSyncStatus, 'ok' | 'running' | 'failing'> = {
    last_run_at: null,
    last_success_at: null,
    errors: [],
    skipped: [],
  };
  private failedRuns = 0;
  private lastAlert: { text: string; at: number } | null = null;

  constructor(
    @InjectRepository(Email)
    private emailRepository: Repository<Email>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private dataSource: DataSource,
    private connection: MailConnectionService,
    private history: MailHistoryService,
    private mailDeals: MailDealsService,
    private loggerService: LoggerService,
  ) {}

  onModuleInit(): void {
    const minutes = Number(process.env.EMAIL_SYNC_INTERVAL_MINUTES ?? 3);
    if (minutes > 0) {
      this.syncTimer = setInterval(() => {
        // the journal (src/audit): what the background sync writes is the mail's (source «почта»)
        AuditJournal.job('mail', 'mail-sync', () => this.syncAllMailboxes()).catch((error) =>
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
   * Rejects when a mailbox could not be copied (the others were).
   */
  syncAllMailboxes(): Promise<void> {
    if (!this.syncRunning) {
      this.syncRunning = this.doSyncAllMailboxes().finally(() => {
        this.syncRunning = null;
      });
    }

    return this.syncRunning;
  }

  status(): MailSyncStatus {
    const failing = [...this.failures.entries()].map(([key, value]) => {
      const [mailbox, , uid] = key.split('|');
      return { mailbox, uid: Number(uid), attempts: value.attempts, error: value.error };
    });
    return {
      ...this.state,
      ok: this.state.errors.length === 0 && failing.length === 0,
      running: !!this.syncRunning,
      failing,
    };
  }

  private async doSyncAllMailboxes(): Promise<void> {
    const errors: { mailbox: string; message: string }[] = [];
    const started = new Date();

    try {
      const imap = await this.connection.client();
      const existing = (await imap.list()).map((mailbox) => mailbox.path);
      const { inbox, sent, spam, trash } = this.connection.mailboxes;
      // INBOX last: the connection keeps the last synced mailbox selected, and a
      // mailbox that is selected cannot be deleted or renamed by another client.
      const used = [sent, spam, trash, inbox];

      for (const mailbox of used) {
        // Spam and trash are known by name only: a renamed mailbox breaks them, the others go on
        if (!mailbox || !existing.includes(mailbox)) {
          errors.push({ mailbox: mailbox ?? '?', message: `На почтовом сервере нет папки «${mailbox ?? ''}»` });
          continue;
        }
        try {
          await this.syncMailbox(mailbox);
        } catch (error) {
          this.loggerService.error(`Mail sync of ${mailbox} failed: ${(error as Error)?.message}`, (error as Error)?.stack);
          errors.push({ mailbox, message: (error as Error)?.message ?? String(error) });
        }
      }
    } catch (error) {
      errors.push({ mailbox: '*', message: `Почтовый сервер недоступен: ${(error as Error)?.message ?? error}` });
    }

    // letters stored before their sender became a contact (an e-mail added to the card later) join
    // the contact and its deal now; they used to stay «without contact» for good
    try {
      const linked = await this.mailDeals.linkLettersOfNewContacts();
      if (linked.letters) this.loggerService.log(`Mail sync: ${linked.letters} letters linked to contacts, ${linked.history} into deals`);
    } catch (error) {
      this.loggerService.warn(`Mail sync: letters of new contacts were not linked: ${(error as Error)?.message}`);
    }

    this.state.last_run_at = started;
    this.state.errors = errors;
    if (errors.length === 0) {
      this.state.last_success_at = started;
      this.failedRuns = 0;
    } else {
      this.failedRuns++;
      // not awaited: Telegram being slow must not hold up the answer of GET /emails/sync
      this.alertAdmins(errors).catch((error) => this.loggerService.warn(`mail sync alert: ${(error as Error)?.message}`));
      throw new Error(errors.map((e) => `${e.mailbox}: ${e.message}`).join('; '));
    }
  }

  /**
   * The hosting does not allow custom IMAP flags that would mark what the CRM
   * already has, so dates limit what is looked at, and of that only the uids
   * not stored yet are downloaded.
   *
   * Messages are downloaded and saved in batches of EMAIL_SYNC_BATCH (50): the
   * first sync of a big mailbox used to parse every message into memory first.
   * The mailbox is locked per batch, not for the whole mailbox, so opening a letter
   * or the copy of a sent one into Sent does not wait for a long first sync; the
   * deal history is written outside the lock (it may open a deal, whose triggers may send mail).
   */
  private async syncMailbox(mailbox: string): Promise<void> {
    const plan = await this.connection.withMailbox(mailbox, async (imap) => {
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
        return { uidValidity, newUids: [] as number[] };
      }

      const known = await this.getSynchronizedUids(foundUids, mailbox);
      const newUids = foundUids
        .filter((uid) => !known.has(uid))
        .sort((a, b) => a - b);
      return { uidValidity, newUids };
    });

    for (const batch of chunks(plan.newUids, syncBatchSize())) {
      const result = await this.connection.withMailbox(mailbox, async (imap) => {
        if (String(selectedMailbox(imap).uidValidity) !== plan.uidValidity) {
          // renumbered while we were copying: the next run matches the copies again
          return { saved: [] as Email[], error: new Error(`UIDVALIDITY of ${mailbox} changed during the sync`) };
        }
        return this.syncBatch(imap, mailbox, plan.uidValidity, batch);
      });

      await this.addToHistory(result.saved);
      if (result.error) throw result.error;
    }

    try {
      await this.backfillHtml(mailbox);
    } catch (error) {
      this.loggerService.warn(`Mail sync: HTML of older letters of ${mailbox} was not loaded: ${(error as Error)?.message}`);
    }
  }

  /**
   * Letters stored before the HTML part was kept (html IS NULL) get it now, a few per run, and the
   * text when theirs was empty or had the cells of a table glued together; their entries in the deal
   * history get the text too. A letter that is no longer on the server, or has no HTML, gets '' (done).
   */
  private async backfillHtml(mailbox: string): Promise<void> {
    await this.connection.withMailbox(mailbox, async (imap) => {
      const validity = String(selectedMailbox(imap).uidValidity);
      const rows = await this.emailRepository
        .createQueryBuilder('t0')
        .select(['t0.id', 't0.email_id', 't0.body', 't0.outgoing'])
        .withDeleted()
        .where('t0.from_mailbox = :mailbox', { mailbox })
        .andWhere('t0.html IS NULL')
        .andWhere('t0.email_id IS NOT NULL')
        .andWhere('t0.uidvalidity = :validity', { validity })
        .orderBy('t0.id', 'DESC')
        .limit(HTML_BACKFILL_BATCH)
        .getMany();
      if (!rows.length) return;

      const byUid = new Map(rows.map((row) => [Number(row.email_id), row]));
      const done = new Set<number>();
      for await (const message of imap.fetch([...byUid.keys()], { source: true, uid: true }, { uid: true })) {
        const row = byUid.get(Number(message.uid));
        if (!row || done.has(row.id)) continue;
        done.add(row.id);
        try {
          const parsed = await simpleParser(message.source);
          let html = typeof parsed.html === 'string' ? noNul(parsed.html) : '';
          if (html.length > MAX_HTML) html = html.replace(/(\ssrc\s*=\s*)(["'])data:[^"']*\2/gi, '$1$2$2');
          if (html.length > MAX_HTML) html = '';
          const body = bodyOf(parsed.text, html || null);
          const old = String(row.body ?? '');
          const squash = (value: string) => value.replace(/\s+/g, '');
          const newBody = body.trim() && body !== old && (!old.trim() || squash(old) === squash(body)) ? body : null;
          await this.emailRepository.update(row.id, newBody !== null ? { html, body: newBody } : { html });
          if (newBody !== null && !row.outgoing) {
            await this.dataSource.query(
              `UPDATE event SET after_state = jsonb_set(after_state, '{data,body}', to_jsonb($1::text))
                WHERE type = 9 AND (after_state -> 'data') ->> 'id' = $2`,
              [splitQuote(newBody).main, String(row.id)],
            );
          }
        } catch (error) {
          this.loggerService.warn(`Mail sync: letter ${row.id} could not be read again: ${(error as Error)?.message}`);
          await this.emailRepository.update(row.id, { html: '' });
        }
      }
      const missing = rows.filter((row) => !done.has(row.id)).map((row) => row.id);
      if (missing.length) await this.emailRepository.update(missing, { html: '' });
    });
  }

  /**
   * Letters just copied go into the history of the deals they belong to (MailDealsService: the
   * sender's or the recipients' open deals and the thread's; a returning client gets a repeat deal).
   * A letter whose deals cannot be found is logged and stays in Mail.
   */
  private async addToHistory(letters: Email[]): Promise<void> {
    const items: HistoryItem[] = [];
    for (const email of letters) {
      if (!this.history.belongsToHistory(email)) continue;
      try {
        const deals = email.outgoing ? await this.mailDeals.forSent(email) : await this.mailDeals.forReceived(email);
        if (deals.length) items.push({ email, deals, originatedBy: email.from_user ?? null });
      } catch (error) {
        this.loggerService.error(`Mail sync: the deals of letter ${email.id} were not found: ${(error as Error)?.message}`, (error as Error)?.stack);
      }
    }
    try {
      await this.history.add(items);
    } catch (error) {
      this.loggerService.error(`Mail sync: deal history was not written: ${(error as Error)?.message}`, (error as Error)?.stack);
    }
  }

  /**
   * Downloads and saves one batch of new messages of a mailbox, each letter on its own.
   * Returns the saved letters (for the deal history) and the error of the download itself, if any:
   * what was saved before it still goes into the history.
   */
  private async syncBatch(
    imap: ImapFlow,
    mailbox: string,
    uidValidity: string,
    uids: number[],
  ): Promise<{ saved: Email[]; error: Error | null }> {
    const saved: Email[] = [];
    try {
      const messages = imap.fetch(
        uids,
        { source: true, flags: true, uid: true, envelope: true, internalDate: true },
        { uid: true },
      );

      for await (const message of messages) {
        const key = `${mailbox}|${uidValidity}|${message.uid}`;
        try {
          const letter = await this.toEmail(message, mailbox);
          letter.email.uidvalidity = uidValidity;
          const stored = await this.store(letter.email, letter.attachments);
          if (stored) saved.push(stored);
          this.failures.delete(key);
        } catch (error) {
          const stub = await this.onLetterFailed(key, message, mailbox, uidValidity, error as Error);
          if (stub) saved.push(stub);
        }
      }
    } catch (error) {
      return { saved, error: error as Error };
    }
    return { saved, error: null };
  }

  /** A message of the server as an unsaved Email and its attachments (not written yet). */
  private async toEmail(
    message: FetchMessageObject,
    mailbox: string,
  ): Promise<{ email: Email; attachments: PendingAttachment[] }> {
    const parsed = await simpleParser(message.source);
    const email = new Email();
    const sender = parsed.from?.value?.[0];

    email.from = clip(sender?.address, 10000);
    email.from_name = clip(sender?.name?.trim() || null, 255);
    email.subject = clip(parsed.subject, 10000);
    email.email_id = Number(message.uid);
    email.cc = addresses(parsed.cc, EmailCc);
    email.to = addresses(parsed.to, EmailTo);
    email.sent_at = asDate(parsed.date) ?? asDate(message.internalDate) ?? new Date();
    email.thread_id = clip(message.threadId, 255);
    email.message_id = messageIdOf(parsed.messageId);
    email.in_reply_to = messageIdsIn(parsed.inReplyTo)[0] ?? null;
    email.reference_ids = messageIdsIn(parsed.references).join(' ').slice(0, 20000) || null;
    email.from_mailbox = mailbox;
    email.outgoing = this.isOutgoing(email.from, mailbox, [...email.to, ...email.cc].map((r) => r.value));

    // HTML as it came (cleaned by the client when shown); embedded images go when it is too big
    let html = typeof parsed.html === 'string' ? noNul(parsed.html) : null;
    let imagesInHtml = !!html;
    if (html && html.length > MAX_HTML) {
      html = html.replace(/(\ssrc\s*=\s*)(["'])data:[^"']*\2/gi, '$1$2$2');
      imagesInHtml = false;
      if (html.length > MAX_HTML) html = null;
    }
    // '' = no HTML part (NULL: a letter stored before the HTML was kept, backfillHtml reads it again)
    email.html = html ?? '';
    // the text: the text part; a letter of HTML only (or with an empty text part, as some mailers send)
    // gets the text of its HTML, with table cells and paragraphs apart («50x90 | 300 | 12 500 сум»)
    email.body = bodyOf(parsed.text, typeof parsed.html === 'string' ? parsed.html : null);

    if (message.flags && message.flags.has('\\Seen')) {
      email.read = true;
    }

    if (mailbox === this.connection.mailboxes.spam) {
      email.is_spam = true;
    } else if (mailbox === this.connection.mailboxes.trash) {
      email.deleted_at = new Date();
    }

    // A received letter: its sender as a contact (ctr_agent) when there is one, else as whoever has
    // the address. A sent one: the staff member who sent it. Deals are chosen later (MailHistoryService).
    email.from_user = email.from ? await this.userOf(email.from, !email.outgoing) : null;

    const attachments: PendingAttachment[] = [];
    for (const attachment of parsed.attachments || []) {
      if (!attachment) continue;
      // an image of the HTML (logo of a signature, a picture in the text) is in the HTML already
      if ((attachment as any).related && imagesInHtml && !/\bcid:/i.test(html ?? '')) continue;
      attachments.push(
        receivedAttachment(
          attachment.content,
          safeFileName(attachment.filename, attachment.contentType?.startsWith('image/') ? 'image' : 'attachment'),
          attachment.size,
          email.from_user ?? undefined,
        ),
      );
    }

    return { email, attachments };
  }

  /**
   * Saves a letter and its files, one transaction for the row and its addresses and files; the files
   * on disk go again when the row cannot be saved. Returns null for a copy the CRM already has:
   *  - a letter the CRM moved itself to Spam / Trash on a server without UIDPLUS (the row waits
   *    there with no uid): the row gets this uid;
   *  - a second copy of a letter the CRM shows (delivered twice, the shared mailbox in Cc of a letter
   *    sent from the CRM): saved hidden, so that it is not fetched again.
   * A letter that turns up in Trash or Spam was moved there in webmail: its copies in other
   * mailboxes stop being shown.
   */
  private async store(email: Email, attachments: PendingAttachment[]): Promise<Email | null> {
    const { spam, trash } = this.connection.mailboxes;
    const moving = email.from_mailbox === spam || email.from_mailbox === trash;

    if (email.message_id) {
      const twins = await this.emailRepository
        .createQueryBuilder('t0')
        .select(['t0.id', 't0.email_id', 't0.from_mailbox', 't0.is_spam', 't0.deleted_at', 't0.from', 't0.subject'])
        .withDeleted()
        .where('t0.message_id = :mid', { mid: email.message_id })
        .getMany();
      const same = twins.filter(
        (t) => (t.from ?? '').toLowerCase() === (email.from ?? '').toLowerCase() && (t.subject ?? '') === (email.subject ?? ''),
      );

      const waiting = same.find((t) => t.from_mailbox === email.from_mailbox && !t.email_id);
      if (waiting) {
        await this.emailRepository.update(waiting.id, { email_id: email.email_id, uidvalidity: email.uidvalidity });
        return null;
      }

      if (moving) {
        const elsewhere = same.filter((t) => t.from_mailbox !== email.from_mailbox && !t.deleted_at);
        if (elsewhere.length) {
          await this.emailRepository.softDelete(elsewhere.map((t) => t.id));
        }
      } else {
        // taken out of Spam in webmail: the spam copy goes
        const spamCopies = same.filter((t) => t.is_spam && !t.deleted_at && t.from_mailbox !== email.from_mailbox);
        if (spamCopies.length) {
          await this.emailRepository.softDelete(spamCopies.map((t) => t.id));
        }
        if (same.some((t) => !t.deleted_at && !t.is_spam)) {
          email.deleted_at = new Date();
        }
      }
    }

    const files = await writeAttachments(attachments);
    email.files = files;
    try {
      return await this.emailRepository.save(email);
    } catch (error) {
      await removeWritten(files);
      throw error;
    }
  }

  /**
   * A letter could not be parsed or saved. It is tried again on the next runs; after MAX_ATTEMPTS
   * it is saved with its headers only (and a note), so that the mailbox goes on and the letter is
   * not lost from sight: it can be read in the mailbox on the server.
   */
  private async onLetterFailed(
    key: string,
    message: FetchMessageObject,
    mailbox: string,
    uidValidity: string,
    error: Error,
  ): Promise<Email | null> {
    const reason = (error?.message ?? String(error)).slice(0, 300);
    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
    this.loggerService.error(
      `Mail sync: letter uid ${message.uid} of ${mailbox} failed (attempt ${attempts} of ${MAX_ATTEMPTS}): ${reason}`,
      error?.stack,
    );
    if (attempts < MAX_ATTEMPTS) {
      this.failures.set(key, { attempts, error: reason });
      return null;
    }

    try {
      const envelope = message.envelope;
      const stub = new Email();
      stub.email_id = Number(message.uid);
      stub.uidvalidity = uidValidity;
      stub.from_mailbox = mailbox;
      stub.from = clip(envelope?.from?.[0]?.address, 10000);
      stub.from_name = clip(envelope?.from?.[0]?.name || null, 255);
      stub.subject = clip(envelope?.subject, 10000);
      stub.message_id = messageIdOf(envelope?.messageId);
      stub.in_reply_to = messageIdOf(envelope?.inReplyTo);
      stub.sent_at = asDate(envelope?.date) ?? asDate(message.internalDate) ?? new Date();
      stub.body = `Письмо не удалось загрузить в CRM (${noNul(reason)}). Оно лежит в папке «${mailbox}» почтового ящика на сервере: откройте его в почтовой программе.`;
      stub.to = [];
      stub.cc = [];
      stub.files = [];
      stub.html = '';
      stub.outgoing = this.isOutgoing(stub.from, mailbox, []);
      stub.is_spam = mailbox === this.connection.mailboxes.spam;
      if (mailbox === this.connection.mailboxes.trash) stub.deleted_at = new Date();
      stub.from_user = stub.from ? await this.userOf(stub.from, !stub.outgoing) : null;

      const saved = await this.emailRepository.save(stub);
      this.failures.delete(key);
      this.state.skipped = [
        { mailbox, uid: Number(message.uid), subject: stub.subject, error: reason, at: new Date() },
        ...this.state.skipped,
      ].slice(0, 20);
      return saved;
    } catch (stubError) {
      this.failures.set(key, { attempts, error: reason });
      this.loggerService.error(`Mail sync: the stub of uid ${message.uid} of ${mailbox} was not saved either`, (stubError as Error)?.stack);
      return null;
    }
  }

  /**
   * A letter we sent: it lies in Sent, or it is from our address and goes to someone outside the
   * company (the shared mailbox in Cc of a letter written in Outlook). A colleague's letter to our
   * addresses only (a forwarded request) is incoming: it used to land in «Отправленные».
   */
  private isOutgoing(from: string | null | undefined, mailbox: string, recipients: string[]): boolean {
    if (mailbox === this.connection.mailboxes.sent) return true;
    if (!this.isOurs(from)) return false;
    return addressesIn(recipients).some((address) => !this.isOurs(address));
  }

  /** From a company address (the shared mailbox's domain, parisahome.com). */
  private isOurs(address: string | null | undefined): boolean {
    const from = String(address ?? '').toLowerCase();
    if (!from) return false;
    const shared = String(process.env.EMAIL_DEFAULT_USER ?? '').toLowerCase();
    const domain = shared.includes('@') ? shared.slice(shared.lastIndexOf('@')) : '';
    return from.endsWith('@parisahome.com') || (!!domain && from.endsWith(domain));
  }

  /**
   * The user with this address: for a received letter the contact (ctr_agent) when there is one
   * — whatever their deals are: a client whose deals are all closed used to be "unknown" —, else
   * anybody with the address (a colleague writing from another mailbox).
   */
  private async userOf(address: string, preferContact: boolean): Promise<User | null> {
    const users = await this.userRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.company', 'company')
      .where('LOWER(t0.email) = LOWER(:email)', { email: address })
      .orderBy('t0.id', 'ASC')
      .getMany();
    if (!users.length) return null;
    const contacts = users.filter((u) => u.role === RoleEnum.CTR_AGENT);
    const staff = users.filter((u) => u.role !== RoleEnum.CTR_AGENT);
    return (preferContact ? contacts[0] ?? staff[0] : staff[0] ?? contacts[0]) ?? null;
  }

  /**
   * The admins who linked the CRM bot hear about a mailbox that keeps failing: after two failed runs
   * in a row, then at most every EMAIL_SYNC_ALERT_HOURS (6) for the same problem; 0 turns it off.
   */
  private async alertAdmins(errors: { mailbox: string; message: string }[]): Promise<void> {
    const hours = Number(process.env.EMAIL_SYNC_ALERT_HOURS ?? 6);
    const token = (process.env.CRM_BOT_TOKEN || '').trim();
    if (!(hours > 0) || !token || this.failedRuns < 2) return;

    const text = errors.map((e) => `${e.mailbox}: ${e.message}`).join('\n').slice(0, 1500);
    if (this.lastAlert && this.lastAlert.text === text && Date.now() - this.lastAlert.at < hours * 3600_000) return;
    this.lastAlert = { text, at: Date.now() };

    const chats: { chat_id: string }[] = await this.dataSource.query(
      `SELECT b.chat_id FROM bot_account b JOIN "user" u ON u.id = b.user_id WHERE u.role = $1 AND u.deleted_at IS NULL`,
      [RoleEnum.ADMIN],
    );
    if (!chats.length) return;
    const last = this.state.last_success_at ? this.state.last_success_at.toLocaleString('ru-RU') : 'не было';
    const api = new TelegramBotApi(token, process.env.CRM_BOT_API_BASE || undefined);
    for (const chat of chats) {
      await api
        .sendMessage(chat.chat_id, `Почта: письма не загружаются в CRM.\n${text}\nПоследняя успешная загрузка: ${last}.`)
        .catch((error) => this.loggerService.warn(`mail sync alert: ${(error as Error)?.message}`));
    }
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

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

/**
 * To/Cc rows of a parsed header: one row per address (`"Name" <a@x>` or `a@x`), so that the filter
 * by an address finds letters with several recipients (they used to be one row per header).
 */
function addresses<T extends EmailTo | EmailCc>(
  header: AddressObject | AddressObject[] | undefined,
  Row: new () => T,
): T[] {
  const groups = Array.isArray(header) ? header : header ? [header] : [];
  const rows: T[] = [];
  const add = (value: string) => {
    const clean = noNul(value).trim();
    if (!clean) return;
    const row = new Row();
    row.value = clean.slice(0, 2000);
    rows.push(row);
  };

  for (const group of groups) {
    const list = group.value ?? [];
    if (!list.length) {
      add(group.text ?? '');
      continue;
    }
    for (const entry of list) {
      // a group ("Undisclosed recipients: a@x, b@y;") holds addresses of its own
      for (const one of entry.group?.length ? entry.group : [entry]) {
        if (!one.address && !one.name) continue;
        const name = (one.name ?? '').replace(/"/g, '').trim();
        add(one.address ? (name ? `"${name}" <${one.address}>` : one.address) : name);
      }
    }
  }
  return rows;
}

/**
 * The text of a letter: its text part; else (empty or missing) the text of its HTML part. mailparser
 * makes the text of an HTML-only letter itself and glues table cells together («50x9030012 500 сум»):
 * when the text part is the HTML's words without the separators, the HTML's text is taken.
 */
export function bodyOf(text: string | null | undefined, html: string | null | undefined): string {
  const plain = noNul(String(text ?? ''));
  if (!html) return plain;
  const fromHtml = htmlToText(html);
  if (!plain.trim()) return fromHtml;
  const squash = (value: string) => value.replace(/\s+/g, '');
  return squash(plain) === squash(fromHtml) ? fromHtml : plain;
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
