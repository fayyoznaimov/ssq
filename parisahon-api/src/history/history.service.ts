import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { Access } from '../auth/access';
import { ANSWER_TYPES, CHAT_TYPES, answerSql, clientMessageSql } from '../analytics/control.service';
import { CLIENT_DEALS_SQL } from '../deal/client-history.service';
import { Deal } from '../deal/deal.entity';
import { isLostStage } from '../deal_stage/stage-kind';
import { Field, FieldValueEventDto } from '../events/dto/field.value.event.dto';
import { SearchEventDto } from '../events/dto/search.event.dto';
import { Event, EventTypes, FieldsOf } from '../events/event.entity';
import { EventsService } from '../events/events.service';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { User } from '../user/user.entity';
import { LOST_REASONS, LOST_REASON_OTHER, LostReasonDto } from './lost-reasons';

/**
 * The deal page's readable history (DEAL-7, DEAL-10, DEAL-11, DEAL-14):
 *  - summary(): the header of the deal — its number, the stage and how long it has been in it, where
 *    the deal came from, and «клиент ждёт ответа» when the client wrote last;
 *  - clientFeed(): the history of the whole client (every deal of the deal's company and contacts the
 *    user may see, and the notes of their cards), the same filters and search as the deal's own feed;
 *  - setLostReason(): why a lost deal was lost, on the deal and in its history.
 */

/** The channel of the first client event of a deal: the same rule as the trigger condition «источник сделки». */
const SOURCE_BY_EVENT: Record<number, string> = {
  [EventTypes.NEW_TELEGRAM_MESSAGE]: 'telegram',
  [EventTypes.NEW_WHATSAPP_MESSAGE]: 'whatsapp',
  [EventTypes.NEW_EMAIL]: 'email',
  [EventTypes.NEW_CALL_RECORDING]: 'call',
};

/** «Клиент ждёт ответа» looks this far back (as «Контроль менеджеров», CONTROL_WAITING_DAYS). */
const WAITING_DAYS = () => Math.max(1, Math.min(365, Number(process.env.CONTROL_WAITING_DAYS || 30)));

const CHANNEL_OF: Record<number, string> = {
  [EventTypes.NEW_EMAIL]: 'email',
  [EventTypes.NEW_SMS]: 'sms',
  [EventTypes.NEW_TELEGRAM_MESSAGE]: 'telegram',
  [EventTypes.NEW_WHATSAPP_MESSAGE]: 'whatsapp',
};

export interface DealSummary {
  id: number;
  display_id: number;
  label: string;
  created_at: Date;
  closed_at: Date | null;
  stage: { id: number; name: string; color: string | null; kind: string | null } | null;
  /** since when the deal is in its stage (the last move, else its creation) and whole days of it */
  stage_since: Date;
  days_in_stage: number;
  source: 'telegram' | 'whatsapp' | 'email' | 'call' | 'manual';
  /** the client wrote last and nobody has answered yet (open deals only) */
  waiting: { since: Date; minutes: number; channel: string | null } | null;
  lost_reason: string | null;
  lost_comment: string | null;
  lost_reasons: readonly string[];
  repeat_of: { id: number; display_id: number; label: string } | null;
  /** other deals of the same client the user may see: the toggle «Эта сделка / Весь клиент» */
  client_deals: number;
}

@Injectable()
export class HistoryService {
  constructor(
    private dataSource: DataSource,
    private events: EventsService,
    private eventEmitter: EventEmitter2,
  ) {}

  /** The deal's company (its own, else the company of a contact) and contacts: who «the client» is. */
  private async clientOf(dealId: number): Promise<{ companyId: number | null; contactIds: number[] }> {
    const deal = (
      await this.dataSource.query(`SELECT company_id FROM deal WHERE id = $1 AND deleted_at IS NULL`, [dealId])
    )[0];
    if (!deal) throw new NotFoundException(`Deal ${dealId} not found`);
    const contacts: { id: number; company_id: number | null }[] = await this.dataSource.query(
      `SELECT u.id, u.company_id FROM deal_user du JOIN "user" u ON u.id = du."userId" WHERE du."dealId" = $1 ORDER BY u.id`,
      [dealId],
    );
    const companyId = deal.company_id ?? contacts.find((c) => c.company_id)?.company_id ?? null;
    return { companyId: companyId === null ? null : Number(companyId), contactIds: contacts.map((c) => Number(c.id)) };
  }

  /** SQL (alias d) and parameters: the deals of the client of the deal, the deal itself always. */
  private static clientDeals(dealId: number, client: { companyId: number | null; contactIds: number[] }) {
    return {
      sql: `(d.id = :history_deal_id OR ${CLIENT_DEALS_SQL})`,
      params: {
        history_deal_id: dealId,
        company_id: client.companyId ?? 0,
        contact_ids: client.contactIds.length ? client.contactIds : [0],
      },
    };
  }

  async summary(dealId: number, access: Access): Promise<DealSummary> {
    const row = (
      await this.dataSource.query(
        `SELECT d.id, d.display_id, d.label, d.created_at, d.closed_at, d.lost_reason, d.lost_comment,
                COALESCE(d.last_stage_change, d.created_at) AS stage_since,
                GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(d.last_stage_change, d.created_at))) / 86400))::int AS days_in_stage,
                s.id AS stage_id, s.name AS stage_name, s.color AS stage_color, s.kind AS stage_kind,
                r.id AS repeat_id, r.display_id AS repeat_display_id, r.label AS repeat_label,
                (SELECT e.type FROM event e WHERE e.deal_id = d.id AND e.type = ANY($2)
                  ORDER BY e.created_at, e.id LIMIT 1) AS first_type
           FROM deal d
           LEFT JOIN deal_stage s ON s.id = d.stage_id
           LEFT JOIN deal r ON r.id = d.repeat_of_id AND r.deleted_at IS NULL
          WHERE d.id = $1 AND d.deleted_at IS NULL`,
        [dealId, Object.keys(SOURCE_BY_EVENT).map(Number)],
      )
    )[0];
    if (!row) throw new NotFoundException(`Deal ${dealId} not found`);

    let waiting: DealSummary['waiting'] = null;
    if (!row.closed_at) {
      const asked = (
        await this.dataSource.query(
          `SELECT q.created_at, q.type,
                  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - q.created_at)) / 60))::int AS minutes
             FROM event q
            WHERE q.deal_id = $1 AND ${clientMessageSql('q', '$2')}
              AND q.created_at > now() - make_interval(days => $4::int)
              AND q.created_at > COALESCE((SELECT MAX(o.created_at) FROM event o
                                            WHERE o.deal_id = $1 AND ${answerSql('o', '$3')}), '-infinity')
            ORDER BY q.created_at, q.id LIMIT 1`,
          [dealId, CHAT_TYPES, ANSWER_TYPES, WAITING_DAYS()],
        )
      )[0];
      if (asked) waiting = { since: asked.created_at, minutes: Number(asked.minutes), channel: CHANNEL_OF[Number(asked.type)] ?? null };
    }

    const client = await this.clientOf(dealId);
    const deals = HistoryService.clientDeals(dealId, client);
    const scope = access.dealSql('d', 'view');
    const others = await this.dataSource
      .createQueryBuilder()
      .select('COUNT(*)', 'count')
      .from(Deal, 'd')
      .where('d.id <> :history_deal_id')
      .andWhere('d.deleted_at IS NULL')
      .andWhere(deals.sql, deals.params)
      .andWhere(scope.sql, scope.params)
      .getRawOne<{ count: string }>();

    return {
      id: Number(row.id),
      display_id: Number(row.display_id),
      label: row.label,
      created_at: row.created_at,
      closed_at: row.closed_at,
      stage: row.stage_id
        ? { id: Number(row.stage_id), name: row.stage_name, color: row.stage_color ?? null, kind: row.stage_kind ?? null }
        : null,
      stage_since: row.stage_since,
      days_in_stage: Number(row.days_in_stage ?? 0),
      source: (SOURCE_BY_EVENT[Number(row.first_type)] ?? 'manual') as DealSummary['source'],
      waiting,
      lost_reason: row.lost_reason ?? null,
      lost_comment: row.lost_comment ?? null,
      lost_reasons: LOST_REASONS,
      repeat_of: row.repeat_id ? { id: Number(row.repeat_id), display_id: Number(row.repeat_display_id), label: row.repeat_label } : null,
      client_deals: Number(others?.count ?? 0),
    };
  }

  /**
   * GET /deals/:id/client-events: the history of every deal of the client the user may see (each row
   * with its deal: № and name), and what is written on the cards of the client's company and contacts
   * outside deals. One message stored in several deals of the client is one row in the client (the
   * web client folds them by the message key). Mail as in the deal's own feed (hideMail).
   */
  async clientFeed(dealId: number, query: SearchEventDto, access: Access): Promise<PaginationResponseDto<Event[]>> {
    const client = await this.clientOf(dealId);
    const deals = HistoryService.clientDeals(dealId, client);
    const scope = access.dealSql('d', 'view');
    const qb = this.dataSource
      .getRepository(Event)
      .createQueryBuilder('t0')
      .where(
        `(t0.deal_id IN (SELECT d.id FROM deal d WHERE d.deleted_at IS NULL AND ${deals.sql} AND ${scope.sql})
          OR (t0.deal_id IS NULL AND (t0.company_id = :company_id OR t0.contact_id IN (:...contact_ids))))`,
        { ...deals.params, ...scope.params },
      );
    const page = await this.events.applyEventFilters(query, qb, { withDeal: true, canReadMail: access.canReadMail });
    return EventsService.hideMail(page, access.canReadMail);
  }

  /**
   * PATCH /deals/:id/lost: the reason and the comment of a deal that is in the stage of kind `lost`.
   * Written to the deal (the reports read it) and to its history («Причина проигрыша: Цена — дорого»).
   * «Другое» needs a comment. The deal must already be in the lost stage (the stage is changed by the
   * usual PATCH /deals/:id/stage first): a reason of an open or a won deal would mislead the reports.
   */
  async setLostReason(dealId: number, data: LostReasonDto, userId: number): Promise<{ lost_reason: string; lost_comment: string | null }> {
    const row = (
      await this.dataSource.query(
        `SELECT d.id, d.lost_reason, d.lost_comment, s.kind AS stage_kind
           FROM deal d LEFT JOIN deal_stage s ON s.id = d.stage_id
          WHERE d.id = $1 AND d.deleted_at IS NULL`,
        [dealId],
      )
    )[0];
    if (!row) throw new NotFoundException(`Deal ${dealId} not found`);
    if (!isLostStage({ kind: row.stage_kind })) {
      throw new BadRequestException('Причину проигрыша можно указать только у сделки в этапе «Закрыто и не реализовано»');
    }
    const reason = String(data.reason ?? '').trim();
    const comment = String(data.comment ?? '').trim() || null;
    if (reason === LOST_REASON_OTHER && !comment) {
      throw new BadRequestException('Для причины «Другое» напишите комментарий');
    }

    await this.dataSource
      .createQueryBuilder()
      .update(Deal)
      .set({ lost_reason: reason, lost_comment: comment })
      .where('id = :id', { id: dealId })
      .execute();

    const text = (r: string | null, c: string | null) => (r ? (c ? `${r} — ${c}` : r) : null);
    const before = text(row.lost_reason ?? null, row.lost_comment ?? null);
    const after = text(reason, comment);
    if (before !== after) {
      const event = new FieldValueEventDto();
      event.deal = { id: dealId } as Deal;
      event.originated_by = ((await this.dataSource.getRepository(User).findOne({ where: { id: userId } })) ?? undefined) as User;
      event.fields_of = FieldsOf.DEAL;
      event.fields = [new Field('lost_reason', after, before)];
      this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), event);
    }
    return { lost_reason: reason, lost_comment: comment };
  }
}
