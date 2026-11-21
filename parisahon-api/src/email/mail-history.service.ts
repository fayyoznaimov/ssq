import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { EmailEventDto } from '../events/dto/email.event.dto';
import { Event, EventTypes } from '../events/event.entity';
import { User } from '../user/user.entity';
import { Email } from './email.entity';

/** Emails in the history of deals: NEW_EMAIL events, written by the events module. */
@Injectable()
export class MailHistoryService {
  constructor(
    @InjectRepository(Event)
    private eventRepository: Repository<Event>,
    private eventEmitter: EventEmitter2,
  ) {}

  /** A received email goes to the open deals of its sender (a contact), once. */
  async addReceived(emails: Email[]): Promise<void> {
    const events: EmailEventDto[] = [];

    for (const email of emails) {
      for (const deal of email.from_user?.linked_deals ?? []) {
        events.push(MailHistoryService.event(email, deal, email.from_user));
      }
    }

    this.emit(await this.withoutEmitted(events));
  }

  /** An email sent from the CRM goes to the given deals. */
  addSent(email: Email, deals: Deal[], originatedBy: User): void {
    const copy = MailHistoryService.forHistory(email);

    this.emit(
      deals.map((deal) => MailHistoryService.event(copy, deal, originatedBy)),
    );
  }

  private emit(events: EmailEventDto[]): void {
    if (events.length > 0) {
      this.eventEmitter.emit(EventTypes.NEW_EMAIL.toString(), events);
    }
  }

  private static event(
    email: Email,
    deal: Deal,
    originatedBy: User,
  ): EmailEventDto {
    const event = new EmailEventDto();

    event.email = email;
    event.deal = deal;
    event.originated_by = originatedBy;

    return event;
  }

  /**
   * The copy of a sent email that goes into deal history. The event listener
   * strips `from_user.linked_deals` without checking that there is a
   * `from_user` (an outgoing email has none), so an outgoing email never
   * reached deal history: give it an empty one. `sent_by` is the full staff
   * record and does not belong in the history either.
   */
  private static forHistory(email: Email): Email {
    return Object.assign(new Email(), email, {
      from_user: email.from_user ?? ({} as User),
      sent_by: undefined,
    });
  }

  /** Drops the events whose email (by IMAP uid) is already in that deal's history. */
  private async withoutEmitted(
    events: EmailEventDto[],
  ): Promise<EmailEventDto[]> {
    const dealIds = [
      ...new Set(
        events
          .map((event) => event.deal?.id)
          .filter((id) => id !== null && id !== undefined),
      ),
    ];

    if (dealIds.length === 0) {
      return events;
    }

    const existing = await this.eventRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.deal', 't2')
      .where('t0.type = :event_type', { event_type: EventTypes.NEW_EMAIL })
      .andWhere('t0.deal_id IN (:...deal_ids)', { deal_ids: dealIds })
      .getMany();

    return events.filter(
      (event) =>
        !existing.some(
          (old) =>
            old.after_state?.data?.email_id &&
            old.after_state.data.email_id === event.email.email_id &&
            old.deal.id === event.deal.id,
        ),
    );
  }
}
