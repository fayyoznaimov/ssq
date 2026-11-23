import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { EmailEventDto } from '../events/dto/email.event.dto';
import { EventTypes } from '../events/event.entity';
import { User } from '../user/user.entity';
import { Email } from './email.entity';
import { MailConnectionService } from './mail-connection.service';
import { splitQuote } from './mail-text';

/** A letter and the deals whose history it goes into; `body`: the text for the history if not the letter's own. */
export interface HistoryItem {
  email: Email;
  deals: Deal[];
  originatedBy: User | null;
  body?: string;
}

/** How long a letter just put into a deal is remembered (the events are written by a listener, a bit later). */
const RECENT_MS = 10 * 60_000;

/**
 * Emails in the history of deals: NEW_EMAIL events, written by the events module. Which deals a
 * letter goes to is decided by MailDealsService.
 *  - A letter is in a deal's history once, also when it is stored twice (the copy in Sent and the
 *    one in INBOX, delivered twice): the same letter row or the same Message-ID is not added again
 *    (it used to be compared by the IMAP uid alone, which belongs to one mailbox).
 *  - Letters in Spam and Trash are not put into any history.
 *  - Its attachments go to the deal's files («Файлы»), as for letters sent from the CRM.
 *  - The history shows a received letter without the quoted earlier letters (they are entries of
 *    their own); the whole letter stays in Mail (`quoted: true` marks the cut).
 */
@Injectable()
export class MailHistoryService {
  private recent = new Map<string, number>();

  constructor(
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
    private connection: MailConnectionService,
  ) {}

  /** May this letter be in a deal's history: not spam, not deleted. */
  belongsToHistory(email: Email): boolean {
    const { spam, trash } = this.connection.mailboxes;
    return !!email && !email.is_spam && !email.deleted_at && email.from_mailbox !== spam && email.from_mailbox !== trash;
  }

  /** An email sent from the CRM goes to the given deals. */
  async addSent(email: Email, deals: Deal[], originatedBy: User, body?: string): Promise<number> {
    return this.add([{ email, deals, originatedBy, body }]);
  }

  /** Letters into the history of deals: one entry per letter and deal, never twice. Returns how many were added. */
  async add(items: HistoryItem[]): Promise<number> {
    const candidates = items
      .filter((item) => this.belongsToHistory(item.email))
      .flatMap((item) => (item.deals ?? []).filter((deal) => deal?.id).map((deal) => ({ item, deal })));
    if (!candidates.length) return 0;

    const fresh = await this.withoutEmitted(candidates);
    if (!fresh.length) return 0;

    await this.linkFiles(fresh);

    const copies = new Map<Email, Email>();
    const events = fresh.map(({ item, deal }) => {
      if (!copies.has(item.email)) copies.set(item.email, MailHistoryService.forHistory(item.email, item.body));
      return MailHistoryService.event(copies.get(item.email), deal, item.originatedBy);
    });
    this.eventEmitter.emit(EventTypes.NEW_EMAIL.toString(), events);
    return events.length;
  }

  private static event(
    email: Email,
    deal: Deal,
    originatedBy: User | null,
  ): EmailEventDto {
    const event = new EmailEventDto();

    event.email = email;
    event.deal = deal;
    event.originated_by = originatedBy ?? undefined;

    return event;
  }

  /**
   * The copy of a letter that goes into deal history. The event listener strips
   * `from_user.linked_deals` without checking that there is a `from_user` (an
   * outgoing email has none), so the copy always has one. The staff records
   * (`sent_by`, `deleted_by`) and the HTML part do not belong in the history.
   */
  private static forHistory(email: Email, body?: string): Email {
    const from = email.from_user ? Object.assign(new User(), email.from_user) : ({} as User);
    delete (from as any).linked_deals;
    const copy = Object.assign(new Email(), email, {
      from_user: from,
      sent_by: undefined,
      deleted_by: undefined,
      html: undefined,
    });

    if (body !== undefined && body !== null) {
      copy.body = body;
    } else if (!email.outgoing) {
      const { main, quote } = splitQuote(email.body);
      if (quote) {
        copy.body = main;
        (copy as any).quoted = true;
      }
    }
    return copy;
  }

  /** Drops what is already in the deal's history: the same letter row, or the same Message-ID. */
  private async withoutEmitted(
    candidates: { item: HistoryItem; deal: Deal }[],
  ): Promise<{ item: HistoryItem; deal: Deal }[]> {
    const dealIds = [...new Set(candidates.map((c) => Number(c.deal.id)))];
    const rows: { deal_id: number; id: string | null; mid: string | null }[] = await this.dataSource.query(
      `SELECT e.deal_id, (e.after_state -> 'data') ->> 'id' AS id, (e.after_state -> 'data') ->> 'message_id' AS mid
         FROM event e
        WHERE e.type = $1 AND e.deal_id = ANY($2)`,
      [EventTypes.NEW_EMAIL, dealIds],
    );
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.id) seen.add(`${row.deal_id}#${row.id}`);
      if (row.mid) seen.add(`${row.deal_id}@${row.mid}`);
    }

    const now = Date.now();
    for (const [key, at] of this.recent) if (now - at > RECENT_MS) this.recent.delete(key);

    const fresh: { item: HistoryItem; deal: Deal }[] = [];
    for (const candidate of candidates) {
      const email = candidate.item.email;
      const keys = [
        email.id ? `${candidate.deal.id}#${email.id}` : null,
        email.message_id ? `${candidate.deal.id}@${email.message_id}` : null,
      ].filter(Boolean);
      if (!keys.length || keys.some((key) => seen.has(key) || this.recent.has(key))) continue;
      keys.forEach((key) => {
        seen.add(key);
        this.recent.set(key, now);
      });
      fresh.push(candidate);
    }
    return fresh;
  }

  /** The attachments of the letters into the files of their deals (deal_file), once. */
  private async linkFiles(entries: { item: HistoryItem; deal: Deal }[]): Promise<void> {
    const fileIds: number[] = [];
    const dealIds: number[] = [];
    for (const { item, deal } of entries) {
      for (const file of item.email.files ?? []) {
        if (file?.id) {
          fileIds.push(Number(file.id));
          dealIds.push(Number(deal.id));
        }
      }
    }
    if (!fileIds.length) return;
    await this.dataSource.query(
      `INSERT INTO deal_file ("fileId", "dealId")
       SELECT t.f, t.d FROM unnest($1::int[], $2::int[]) AS t(f, d)
       ON CONFLICT DO NOTHING`,
      [fileIds, dealIds],
    );
  }
}
