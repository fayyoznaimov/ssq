import {
  BadRequestException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ImapFlow, MailboxObject } from 'imapflow';
import * as process from 'process';
import { LoggerService } from '../helper/logger.service';

/**
 * The one IMAP connection of the CRM to the company mail server (EMAIL_HOST,
 * EMAIL_IMAP_PORT, account EMAIL_DEFAULT_USER) and the mailboxes it uses.
 */
@Injectable()
export class MailConnectionService implements OnModuleInit, OnModuleDestroy {
  /**
   * Mail clients do not use the spam/trash flags consistently, so spam and
   * trash are known by the mailbox names only.
   */
  readonly mailboxes = {
    inbox: process.env.EMAIL_MAIN_MAILBOX,
    sent: process.env.EMAIL_SENT_MAILBOX,
    spam: process.env.EMAIL_SPAM_MAILBOX,
    trash: process.env.EMAIL_TRASH_MAILBOX,
  };

  private iMap: ImapFlow;
  private imapConnecting: Promise<void> | null = null;

  constructor(private loggerService: LoggerService) {}

  onModuleInit(): void {
    // Not awaited: a mail server that is down or does not answer (imapflow
    // waits up to 90 s for a connection) must not hold up the API start.
    this.ensureImap().catch((error) =>
      this.loggerService.error(
        'IMAP is not available at startup, will retry on next use',
        error.stack,
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.iMap?.logout().catch(() => undefined);
  }

  /** A live connection: every IMAP operation gets it through here. */
  async client(): Promise<ImapFlow> {
    await this.ensureImap();
    return this.iMap;
  }

  /** Runs `work` with `mailbox` selected and locked on the connection. */
  async withMailbox<T>(
    mailbox: string,
    work: (imap: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const imap = await this.client();
    const lock = await imap.getMailboxLock(mailbox);

    try {
      return await work(imap);
    } finally {
      lock.release();
    }
  }

  /**
   * The server closes an idle IMAP connection (imapflow's own socket timeout is
   * 5 minutes) and an ImapFlow instance cannot be reused after that, so a new
   * one is made when the current one does not answer.
   */
  private async ensureImap(): Promise<void> {
    if (this.iMap?.usable) {
      try {
        await this.iMap.noop();
        return;
      } catch (error) {
        // Connection died without a close event yet, fall through to reconnect.
      }
    }

    if (!this.imapConnecting) {
      this.imapConnecting = this.connectImap().finally(() => {
        this.imapConnecting = null;
      });
    }

    await this.imapConnecting;
  }

  private async connectImap(): Promise<void> {
    const log = (entry: any) =>
      this.loggerService.error(`IMAP: ${entry?.msg ?? ''}`, entry?.err?.stack);

    const client = new ImapFlow({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_IMAP_PORT) || 993,
      secure: true,
      auth: {
        user: process.env.EMAIL_DEFAULT_USER,
        pass: process.env.EMAIL_DEFAULT_PASSWORD,
      },
      // imapflow logs every protocol line by default; keep only problems.
      logger: { debug: () => {}, info: () => {}, warn: log, error: log },
    });

    // Without a listener an 'error' event would crash the process.
    client.on('error', (error) =>
      this.loggerService.error('IMAP connection error', error?.stack),
    );

    await client.connect();
    this.iMap = client;
  }
}

/** The mailbox currently selected (locked) on the connection. */
export function selectedMailbox(imap: ImapFlow): MailboxObject {
  const mailbox = imap.mailbox;
  if (!mailbox || typeof mailbox === 'boolean') {
    throw new BadRequestException('IMAP: no mailbox is selected');
  }
  return mailbox;
}
