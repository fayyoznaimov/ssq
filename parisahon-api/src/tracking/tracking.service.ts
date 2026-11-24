import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Event } from '../events/event.entity';
import { HelperService } from '../helper/helper.service';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { SearchTrackingDto } from './dto/search.tracking.dto';
import { EventsService } from '../events/events.service';
import { stripFeedSnapshots } from '../events/feed-privacy';

/** People of a journal row: by name, also when the account was deleted since (AUDIT-7). */
const PERSON = ['id', 'username', 'avatar', 'role', 'deleted_at'];

/** "2026-11-23": a date of the date picker, not a moment. */
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class TrackingService {
  constructor(
    @InjectRepository(Event)
    private eventRepository: Repository<Event>,
    private helperService: HelperService,
  ) {}

  /**
   * GET /logs, «Список событий»: the history of every deal for admin and manager.
   * The period is inclusive: created_after = its first day (from 00:00), created_before = its
   * last day when it is a date (up to 23:59:59), else the moment it names. "За сегодня" used to be
   * yesterday and today (AUDIT-10).
   */
  async fetchLogs(
    query: SearchTrackingDto,
    canReadMail = true,
  ): Promise<PaginationResponseDto<Event[]>> {
    let qb = this.eventRepository.createQueryBuilder('t0').where('TRUE');

    if (query.originated_by) {
      qb = qb.andWhere('t0.user_id = :user_id', { user_id: query.originated_by });
    }

    if (query.types) {
      qb = qb.andWhere('t0.type IN (:...types)', { types: query.types });
    }

    if (query.created_after) {
      qb = qb.andWhere('t0.created_at >= :created_after', {
        created_after: query.created_after,
      });
    }

    if (query.created_before) {
      const day = PLAIN_DATE.test(String(query.created_before).trim());
      qb = qb.andWhere(
        day
          ? "t0.created_at < (CAST(:created_before AS date) + interval '1 day')"
          : 't0.created_at < :created_before',
        { created_before: query.created_before },
      );
    }

    if (query.entities) {
      qb = qb.andWhere('t0.field_of IN (:...entities)', {
        entities: query.entities,
      });
    }

    if (query.deal_id) {
      qb = qb.andWhere('t0.deal_id = :deal_id', { deal_id: query.deal_id });
    }

    if (query.company_id) {
      qb = qb.andWhere('t0.company_id = :company_id', { company_id: query.company_id });
    }

    if (query.contact_id) {
      qb = qb.andWhere('t0.contact_id = :contact_id', { contact_id: query.contact_id });
    }

    // withDeleted: the author or the deal of an older row may be deleted since (the event has no deleted_at)
    qb = qb
      .withDeleted()
      .leftJoin('t0.deal', 'lg_deal')
      .addSelect(['lg_deal.id', 'lg_deal.label', 'lg_deal.display_id'])
      .leftJoin('t0.originated_by', 'lg_by')
      .addSelect(PERSON.map((column) => `lg_by.${column}`))
      .leftJoin('t0.target_user', 'lg_to')
      .addSelect(PERSON.map((column) => `lg_to.${column}`))
      .leftJoin('t0.target_group', 'lg_group')
      .addSelect(['lg_group.id', 'lg_group.name'])
      .leftJoin('t0.task', 'lg_task')
      .addSelect(['lg_task.id', 'lg_task.label'])
      // the client of the row: a note or a change of a card outside deals says whose it is
      .leftJoin('t0.company', 'lg_company')
      .addSelect(['lg_company.id', 'lg_company.name'])
      .leftJoin('t0.contact', 'lg_contact')
      .addSelect(['lg_contact.id', 'lg_contact.username', 'lg_contact.deleted_at']);

    // newest first by the time of the event, the id among events of the same moment
    const sort = query.sort as Record<string, unknown> | undefined;
    const keys = sort && typeof sort === 'object' && !Array.isArray(sort) ? Object.keys(sort) : [];
    const direction = (key: string) => String(sort?.[key] ?? '').trim().toLowerCase();
    // anything else (another column, a wrong direction) goes to the common sort and its 400
    const byTime =
      !sort ||
      (keys.length === 1 &&
        (keys[0] === 'id' || keys[0] === 'created_at') &&
        ['1', '-1', 'asc', 'desc'].includes(direction(keys[0])));
    if (byTime) {
      const ascending = keys.length === 1 && ['1', 'asc'].includes(direction(keys[0]));
      const order = ascending ? 'ASC' : 'DESC';
      qb = qb.orderBy('t0.created_at', order).addOrderBy('t0.id', order);
    }

    const page = await this.helperService.withPagination(qb, query, 't0', null, false, byTime);
    // the employees in the snapshots by name only (SALE-16); letters by the "mail" switch, as every feed
    stripFeedSnapshots(page.data);
    return EventsService.hideMail(page, canReadMail);
  }
}
