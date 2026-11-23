import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { In } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { RoleEnum } from '../user/user.entity';
import { WhichFiles } from '../trigger/dto/assign.trigger.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Event, EventTypes, FieldsOf } from './event.entity';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { HelperService } from '../helper/helper.service';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { CommentEventDto } from './dto/comment.event.dto';
import { Request } from 'express';
import { Deal } from '../deal/deal.entity';
import { CreateCommentDto } from './dto/create.comment.dto';
import { ChatMessageEventDto } from './dto/chat.message.event.dto';
import {
  CreateChatMessageDto,
  MessageTargetTypesEnum,
} from './dto/create.chat.message.dto';
import { Group } from '../group/group.entity';
import { User } from '../user/user.entity';
import { EventBuilder } from './event.builder';
import { EventWrapper } from './event.wrapper';
import { EventListener } from './listeners/event.listener';
import { Task } from '../task/task.entity';
import {
  ChatTypes,
  LinkedEntities,
  SearchEventDto,
} from './dto/search.event.dto';
import { File } from '../file/file.entity';
import { RemapEventDto } from './dto/remap.event.dto';
import { Email } from '../email/email.entity';
import { Company } from '../company/company.entity';
import { COMPANY_DEALS_SQL } from '../deal/client-history.service';

/**
 * The people of a feed row: who did it and to whom, by name. Not the whole account (an agent
 * reading a deal feed got the rights, goals and Telegram id of every colleague in it), and also a
 * deleted employee or contact: the feed shows them as deleted instead of "—" (AUDIT-7).
 */
const FEED_PERSON = ['id', 'username', 'avatar', 'role', 'deleted_at'];

/** What a task change shows in the history; nothing of it changed: no "Задача изменена" event. */
const TASK_FIELDS = (data: any) =>
  JSON.stringify([
    data?.label ?? null,
    data?.start_time ? new Date(data.start_time).getTime() : null,
    data?.end_time ? new Date(data.end_time).getTime() : null,
    !!data?.allDay,
    data?.type?.id ?? null,
    data?.agent?.id ?? null,
    data?.group?.id ?? null,
    data?.deal?.id ?? null,
    data?.company?.id ?? null,
    data?.ctr_agent?.id ?? null,
  ]);

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(Event)
    private eventRepository: Repository<Event>,
    @InjectRepository(Email)
    private emailRepository: Repository<Email>,
    private helperService: HelperService,
  ) { }

  async fetchDealEvents(
    deal_id: number,
    query: SearchEventDto,
    canReadMail = true,
  ): Promise<PaginationResponseDto<Event[]>> {
    // 404 for missing and (soft) deleted deals
    await this.helperService.getById(Deal, deal_id);

    const qb = this.eventRepository
      .createQueryBuilder('t0')
      .where('t0.deal_id = :deal_id', { deal_id });

    return EventsService.hideMail(await this.applyEventFilters(query, qb), canReadMail);
  }

  /**
   * The "mail" switch of the user card is off: an e-mail stays in the feed (when, which way),
   * its subject, addresses, text and files do not. The shape of a letter stays (empty), the web
   * client of before this change reads its fields.
   */
  static hideMail<T extends { data?: Event[] }>(page: T, canReadMail: boolean): T {
    if (canReadMail) return page;
    for (const event of page.data ?? []) {
      if (event.type !== EventTypes.NEW_EMAIL) continue;
      const mail = event.after_state?.data ?? {};
      event.after_state = {
        hidden: true,
        reason: 'no_mail_access',
        data: {
          id: mail.id ?? null,
          outgoing: mail.outgoing ?? event.outgoing,
          sent_at: mail.sent_at ?? event.created_at,
          subject: '',
          from: '',
          to: [],
          cc: [],
          body: '',
          files: [],
        },
      };
      event.before_state = null;
    }
    return page;
  }

  /** Deals of the alias `d` the user may see (no `access`: every deal, as for internal callers). */
  private static visibleDeals(access?: Access): { sql: string; params: Record<string, any> } {
    return access ? access.dealSql('d', 'view') : { sql: 'TRUE', params: {} };
  }

  /**
   * The feed of a company: everything that happened in all of its deals the user may see (an agent
   * with "own deals" read the chats, letters and comments of colleagues' deals here, ACL-4), and the
   * tasks of the company itself (no deal). A company without deals has an empty feed, not a 404.
   */
  async fetchCompanyEvents(
    company_id: number,
    query: SearchEventDto,
    access?: Access,
  ): Promise<PaginationResponseDto<Event[]>> {
    await this.helperService.getById(Company, company_id);

    const deals = EventsService.visibleDeals(access);
    const qb = this.eventRepository
      .createQueryBuilder('t0')
      .where(
        `(t0.deal_id IN (SELECT d.id FROM deal d WHERE d.deleted_at IS NULL AND ${COMPANY_DEALS_SQL} AND ${deals.sql})
          OR (t0.deal_id IS NULL AND t0.task_id IN (SELECT ct.id FROM task ct WHERE ct.company_id = :company_id)))`,
        { company_id, ...deals.params },
      );

    const page = await this.applyEventFilters(query, qb, { withDeal: true });
    return EventsService.hideMail(page, access ? access.canReadMail : true);
  }

  /**
   * The card of a contact: what they wrote and got, everything in their deals the user may see, and
   * the tasks of the contact (no deal). The card of an employee: their own history (admin and
   * manager: anyone's), as GET /users/:id/events always was.
   */
  async fetchUserEvents(
    user_id: number,
    query: SearchEventDto,
    access?: Access,
  ): Promise<PaginationResponseDto<Event[]>> {
    await this.assertUserFeedAccess(user_id, access);

    const deals = EventsService.visibleDeals(access);
    const qb = this.eventRepository
      .createQueryBuilder('t0')
      .where(
        `(t0.user_id = :user_id OR t0.target_user_id = :user_id
          OR t0.deal_id IN (SELECT du."dealId" FROM deal_user du WHERE du."userId" = :user_id)
          OR (t0.deal_id IS NULL AND t0.task_id IN (SELECT ut.id FROM task ut WHERE ut.ctr_agent_id = :user_id)))`,
        { user_id },
      )
      // a deal in the trash or out of the user's scope: not its events either
      .andWhere(
        `(t0.deal_id IS NULL OR t0.deal_id IN (SELECT d.id FROM deal d WHERE d.deleted_at IS NULL AND ${deals.sql}))`,
        deals.params,
      );

    const page = await this.applyEventFilters(query, qb, { withDeal: true });
    return EventsService.hideMail(page, access ? access.canReadMail : true);
  }

  /**
   * GET /users/:id/events and /deals: a contact by the contact rules (RecordAccess('contact') on
   * the route), a staff account only by themselves or admin / manager (a colleague's history).
   */
  async assertUserFeedAccess(user_id: number, access?: Access): Promise<void> {
    if (!access || access.isManager || user_id === access.id) return;
    const row = (await this.eventRepository.query(`SELECT role FROM "user" WHERE id = $1`, [user_id]))[0];
    if (row && row.role !== RoleEnum.CTR_AGENT) {
      throw new ForbiddenException('Only your own data');
    }
  }

  /** sort absent, or newest first by id / created_at: the order of a feed. */
  private static isNewestFirst(sort: unknown): boolean {
    if (sort === undefined || sort === null) return true;
    if (typeof sort !== 'object' || Array.isArray(sort)) return false;
    const keys = Object.keys(sort);
    return keys.every(
      (key) =>
        (key === 'id' || key === 'created_at') &&
        ['-1', 'desc'].includes(String((sort as Record<string, unknown>)[key]).trim().toLowerCase()),
    );
  }

  async applyEventFilters(
    query: SearchEventDto,
    qb: SelectQueryBuilder<Event>,
    options: { withDeal?: boolean } = {},
  ): Promise<PaginationResponseDto<Event[]>> {
    const eventTypesToExclude = [];

    if (query.exclude_chats && query.exclude_chats.length > 0) {
      if (query.exclude_chats.includes(ChatTypes.INNER)) {
        eventTypesToExclude.push(EventTypes.NEW_CHAT_MESSAGE);
      }

      if (query.exclude_chats.includes(ChatTypes.WITH_CLIENTS)) {
        eventTypesToExclude.push(
          EventTypes.NEW_SMS,
          EventTypes.NEW_CALL_RECORDING,
          EventTypes.NEW_TELEGRAM_MESSAGE,
          EventTypes.NEW_TELEGRAM_CALL,
          EventTypes.NEW_WHATSAPP_MESSAGE,
        );
      }
    }

    if (
      query.exclude_linked_entities &&
      query.exclude_linked_entities.length > 0
    ) {
      const fieldsOf: FieldsOf[] = [];
      if (query.exclude_linked_entities.includes(LinkedEntities.COMPANY)) {
        fieldsOf.push(FieldsOf.COMPANY);
      }

      if (query.exclude_linked_entities.includes(LinkedEntities.CONTACTS)) {
        fieldsOf.push(FieldsOf.USER);
      }

      qb = qb.andWhere(
        '(t0.field_of NOT IN (:...fields_of) or t0.field_of IS NULL)',
        {
          fields_of: fieldsOf,
        },
      );
    }

    if (query.exclude_event_types && query.exclude_event_types.length > 0) {
      eventTypesToExclude.push(...query.exclude_event_types);
      // the filter «Новая задача» of the deal page: the changes of tasks are tasks too
      if (query.exclude_event_types.map(Number).includes(EventTypes.NEW_TASK)) {
        eventTypesToExclude.push(EventTypes.NEW_TASK_UPDATE);
      }
    }

    if (eventTypesToExclude.length > 0) {
      qb = qb.andWhere('t0.type NOT IN (:...event_types)', {
        event_types: eventTypesToExclude,
      });
    }

    // withDeleted: the joined author / addressee / group may be deleted since (the event has no deleted_at)
    qb = qb
      .withDeleted()
      .leftJoin('t0.originated_by', 'ev_by')
      .addSelect(FEED_PERSON.map((column) => `ev_by.${column}`))
      .leftJoin('t0.target_user', 'ev_to')
      .addSelect(FEED_PERSON.map((column) => `ev_to.${column}`))
      .leftJoin('t0.target_group', 'ev_group')
      .addSelect(['ev_group.id', 'ev_group.name']);

    // a company's or a contact's feed spans several deals: which one an event is of
    if (options.withDeal) {
      qb = qb
        .leftJoin('t0.deal', 'ev_deal')
        .addSelect(['ev_deal.id', 'ev_deal.label', 'ev_deal.display_id']);
    }

    // newest first by the time of the event (a call synced later, a letter fetched later stand
    // where they happened), the id among events of the same moment; pages do not overlap
    const newestFirst = EventsService.isNewestFirst(query.sort);
    if (newestFirst) {
      qb = qb.orderBy('t0.created_at', 'DESC').addOrderBy('t0.id', 'DESC');
    }

    return this.helperService.withPagination(qb, query, 't0', null, false, newestFirst);
  }

  /**
   * PATCH /tasks/:id: the change is a new history entry ("Задача изменена": who, the version
   * before and after). The entry of the task's creation stays as it was written (AUDIT-12: the edit
   * used to overwrite it, the author of the change was lost and the older versions too).
   */
  async updateTaskEvent(saved_task: Task, editorId?: number): Promise<void> {
    const previous = await this.eventRepository.findOne({
      where: [
        { type: EventTypes.NEW_TASK_UPDATE, task: { id: saved_task.id } },
        { type: EventTypes.NEW_TASK, task: { id: saved_task.id } },
      ],
      order: { id: 'DESC' },
    });

    const after = EventListener.taskState(saved_task);
    const before = previous?.after_state ?? null;
    if (before && TASK_FIELDS(before.data) === TASK_FIELDS(after.data)) {
      return;
    }

    const event = EventBuilder.fromType(EventTypes.NEW_TASK_UPDATE)
      .originatedBy(editorId ? ({ id: editorId } as User) : null)
      .addTask(saved_task)
      .linkToDeal(saved_task.deal ?? null)
      .addBeforeState(before)
      .addAfterState(after);
    if (saved_task.group) event.addTargetGroup(saved_task.group);
    else if (saved_task.agent) event.addTargetUser(saved_task.agent);

    await this.eventRepository.save(event);
  }

  /**
   * Moves an email or a Telegram / WhatsApp message (with its files) from one deal to another,
   * e.g. a message that the inbox put into the contact's latest deal but belongs to an
   * older one. Allowed when the user may edit both deals (the "update" deal right of the API,
   * src/auth/access.ts: admin and manager every deal; an agent by the levels of the user card,
   * their own deals when none is stored).
   *
   * Not silently (AUDIT-12): the deal it leaves gets an EVENT_MOVED entry (what, where to, who),
   * and the message keeps where it came from (after_state.moved).
   */
  async remapEventToDifferentDeal(data: RemapEventDto, user?: AuthUser): Promise<void> {
    const event = await this.helperService.getById(Event, data.event_id, ['deal']);

    // Validate event type
    if (
      ![EventTypes.NEW_EMAIL, EventTypes.NEW_TELEGRAM_MESSAGE, EventTypes.NEW_WHATSAPP_MESSAGE].includes(
        event.type,
      )
    ) {
      throw new BadRequestException(
        `Can only remap emails, Telegram and WhatsApp messages!`,
      );
    }

    const oldDeal = event.deal;
    // 404 for a missing or deleted (trash) deal
    const targetDeal = await this.helperService.getById(
      Deal,
      data.replace_with_deal_id,
      ['agent', 'agent.group'],
    );
    if (oldDeal?.id === targetDeal.id) return;

    if (user) {
      const deals = [targetDeal];
      if (oldDeal) deals.push(await this.helperService.getById(Deal, oldDeal.id, ['agent', 'agent.group']));
      for (const deal of deals) {
        if (!this.canEditDeal(user, deal)) {
          throw new ForbiddenException(`No right to change deal ${deal.id}`);
        }
      }
    }

    event.deal = targetDeal;

    /**
     * If the event type is new email, remap the files of the email to new deal
     */
    if (event.type === EventTypes.NEW_EMAIL) {
      const emailId = event.after_state?.data?.id;
      if (emailId) {
        const email = await this.helperService.getById(Email, emailId, [
          'files',
          'files.deals',
        ]);
        // Removes old deal relation and replaces with new deal
        email.files.forEach((file) => {
          file.deals = file.deals.filter((deal) => deal.id !== oldDeal?.id);
          file.deals.push(targetDeal);
        });

        const savedEmail = await this.emailRepository.save(email);
        const moved = event.after_state?.moved;
        event.after_state = EventWrapper.fromEntity(savedEmail);
        // the deals of the files are links, not a part of the letter in the history
        for (const file of event.after_state?.data?.files ?? []) delete file.deals;
        if (moved) event.after_state.moved = moved;
      }
    }

    // Telegram / WhatsApp: the files of the message (after_state.files[].path) follow it
    if (event.type === EventTypes.NEW_TELEGRAM_MESSAGE || event.type === EventTypes.NEW_WHATSAPP_MESSAGE) {
      const paths = (event.after_state?.files ?? [])
        .map((f: any) => f?.path)
        .filter((p: any) => typeof p === 'string' && p);
      if (paths.length) {
        const fileRepository = this.eventRepository.manager.getRepository(File);
        const files = await fileRepository.find({
          where: { path: In(paths), from: WhichFiles.FROM_MESSAGES },
          relations: { deals: true },
        });
        for (const file of files) {
          file.deals = (file.deals ?? []).filter((d) => d.id !== oldDeal?.id);
          if (!file.deals.some((d) => d.id === targetDeal.id)) file.deals.push(targetDeal);
        }
        await fileRepository.save(files);
      }
    }

    const at = new Date();
    const by = user ? { id: user.sub, username: user.username ?? null } : null;
    const dealRef = (deal: Deal) => (deal ? { id: deal.id, label: deal.label ?? null, display_id: deal.display_id ?? null } : null);
    event.after_state = {
      ...(event.after_state ?? {}),
      moved: [...(event.after_state?.moved ?? []), { from_deal: dealRef(oldDeal), to_deal: dealRef(targetDeal), by, at }],
    };

    await this.eventRepository.save(event);

    if (oldDeal) {
      await this.eventRepository.save(
        EventBuilder.fromType(EventTypes.EVENT_MOVED)
          .originatedBy(user ? ({ id: user.sub } as User) : null)
          .linkToDeal(oldDeal)
          .addCreatedAt(at)
          .addAfterState(
            // what and where to, not the content: the old deal may be read by someone without mail
            EventWrapper.fromEntity({ event_id: event.id, type: event.type, to_deal: dealRef(targetDeal) }),
          ),
      );
    }
  }

  /** The "update" deal right of the API (src/auth/access.ts): admin and manager every deal, an agent by the card. */
  private canEditDeal(user: AuthUser, deal: Deal): boolean {
    return new Access(user).allowsDeal('update', deal.agent?.id ?? null, deal.agent?.group?.id ?? null);
  }

  async markAsReplied(event_id: number, deal_id?: number): Promise<void> {
    const result = await this.eventRepository
      .createQueryBuilder()
      .update(Event)
      .where(deal_id === undefined ? 'id = :event_id' : 'id = :event_id AND deal_id = :deal_id', { event_id, deal_id })
      .set({ replied_at: () => 'CURRENT_TIMESTAMP' })
      .execute();

    if (result.affected === 0) {
      throw new NotFoundException(`Event with id ${event_id} does not exist!`);
    }
  }

  /**
   *  There is no business logic for comments outside of events.
   *  Therefore, they are integrated as a part of events logic!
   */
  async postNewComment(
    deal_id: number,
    data: CreateCommentDto,
    request: Request,
    files: File[],
  ): Promise<Event> {
    const eventData: CommentEventDto = {
      new_value: data.comment,
      deal: await this.helperService.getById(Deal, deal_id),
      originated_by: await this.helperService.extractUserFromRequest(request),
    };

    return this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_COMMENT)
        .originatedBy(eventData.originated_by)
        .addTargetFieldsIfGiven(eventData)
        .linkToDeal(eventData.deal)
        .addAfterState(
          EventWrapper.fromEntity({
            comment: eventData.new_value,
            files: files,
          }),
        ),
    );
  }

  /**
   * An edited comment says so (after_state.data.edited_at) and keeps every earlier text
   * (before_state.data.versions), not only the last one (AUDIT-12).
   */
  async updateComment(
    deal_id: number,
    event_id: number,
    data: CreateCommentDto,
    request: Request,
    files: File[],
  ): Promise<void> {
    const deal = await this.helperService.getById(Deal, deal_id);
    const commentEvent = await this.helperService.getById(Event, event_id, [
      'originated_by',
      'deal',
    ]);

    if (
      commentEvent.deal.id !== deal.id ||
      commentEvent.type !== EventTypes.NEW_COMMENT
    ) {
      throw new NotFoundException(
        `Comment with given properties does not exist!`,
      );
    }

    const userId = this.helperService.extractUserIdFromRequest(request);

    if (commentEvent.originated_by.id !== userId) {
      throw new BadRequestException(
        `Comment ${commentEvent.id} was not originated by ${userId}`,
      );
    }

    const previous = commentEvent.after_state?.data ?? {};
    const versions = [
      ...((commentEvent.before_state?.data?.versions as any[]) ?? []),
      { comment: previous.comment ?? '', at: previous.edited_at ?? commentEvent.created_at },
    ];
    commentEvent.before_state = EventWrapper.fromEntity({ ...previous, versions });
    commentEvent.after_state = EventWrapper.fromEntity({
      comment: data.comment,
      files: [...(previous.files ?? []), ...files],
      edited_at: new Date(),
    });

    await this.eventRepository.save(commentEvent);
  }

  async deleteComment(
    deal_id: number,
    event_id: number,
    request: Request,
  ): Promise<void> {
    const commentEvent = await this.helperService.getById(Event, event_id, [
      'originated_by',
      'deal',
    ]);

    if (commentEvent.type !== EventTypes.NEW_COMMENT) {
      throw new NotFoundException(
        `Comment with given properties does not exist!`,
      );
    }

    const deal = await this.helperService.getById(Deal, deal_id);

    if (commentEvent.deal.id !== deal.id) {
      throw new BadRequestException(
        `Comment ${commentEvent.id} does not belong to deal ${deal.id}`,
      );
    }

    const userId = this.helperService.extractUserIdFromRequest(request);

    if (commentEvent.originated_by.id !== userId) {
      throw new BadRequestException(
        `Comment ${commentEvent.id} was not originated by ${userId}`,
      );
    }

    await this.helperService.deleteById(Event, commentEvent.id);
  }

  /**
   *  There is no business logic for messages outside of events.
   *  Therefore, they are integrated as a part of events logic!
   */
  async postNewChatMessage(
    deal_id: number,
    data: CreateChatMessageDto,
    request: Request,
    files: File[],
  ): Promise<Event> {
    let eventData: ChatMessageEventDto = {
      new_value: data.message,
      deal: await this.helperService.getById(Deal, deal_id),
      originated_by: await this.helperService.extractUserFromRequest(request),
    };

    eventData = await this.assignTarget(data, eventData);

    return this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_CHAT_MESSAGE)
        .originatedBy(eventData.originated_by)
        .addTargetFieldsIfGiven(eventData)
        .linkToDeal(eventData.deal)
        .addAfterState(
          EventWrapper.fromEntity({
            message: eventData.new_value,
            files: files,
          }),
        ),
    );
  }

  private async assignTarget(
    requestData: CreateChatMessageDto,
    eventData: ChatMessageEventDto,
  ): Promise<ChatMessageEventDto> {
    if (requestData.target === MessageTargetTypesEnum.GROUP) {
      eventData['target_group'] = await this.helperService.getById(
        Group,
        Number(requestData.target_id),
      );
      return eventData;
    }

    if (requestData.target === MessageTargetTypesEnum.USER) {
      eventData['target_user'] = await this.helperService.getById(
        User,
        requestData.target_id,
      );
    }

    return eventData;
  }
}
