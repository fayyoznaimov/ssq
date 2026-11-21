import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { In } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
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
  ): Promise<PaginationResponseDto<Event[]>> {
    // 404 for missing and (soft) deleted deals
    await this.helperService.getById(Deal, deal_id);

    const qb = this.eventRepository
      .createQueryBuilder('t0')
      .where('t0.deal_id = :deal_id', { deal_id });

    return this.applyEventFilters(query, qb);
  }

  /**
   * The feed of a company: everything that happened in all of its deals
   * (not only the field changes of the first deal, as before). A company
   * without deals has an empty feed, not a 404.
   */
  async fetchCompanyEvents(
    company_id: number,
    query: SearchEventDto,
  ): Promise<PaginationResponseDto<Event[]>> {
    await this.helperService.getById(Company, company_id);

    const qb = this.eventRepository
      .createQueryBuilder('t0')
      .where(
        `t0.deal_id IN (SELECT d.id FROM deal d WHERE d.deleted_at IS NULL AND ${COMPANY_DEALS_SQL})`,
        { company_id },
      );

    return this.applyEventFilters(query, qb);
  }

  async fetchUserEvents(
    user_id: number,
    query: SearchEventDto,
  ): Promise<PaginationResponseDto<Event[]>> {
    const qb = this.eventRepository
      .createQueryBuilder('t0')
      // a contact's card: what they wrote / got, and everything in their deals
      .where(
        `(t0.user_id = :user_id OR t0.target_user_id = :user_id OR t0.deal_id IN (
          SELECT du."dealId" FROM deal_user du JOIN deal d ON d.id = du."dealId"
          WHERE du."userId" = :user_id AND d.deleted_at IS NULL))`,
        { user_id },
      );

    return this.applyEventFilters(query, qb);
  }

  async applyEventFilters(
    query: SearchEventDto,
    qb: SelectQueryBuilder<Event>,
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
    }

    if (eventTypesToExclude.length > 0) {
      qb = qb.andWhere('t0.type NOT IN (:...event_types)', {
        event_types: eventTypesToExclude,
      });
    }

    return this.helperService.withPagination(
      this.helperService.withRelations(qb, [
        'originated_by',
        'target_user',
        'target_group',
      ]),
      query,
    );
  }

  async updateTaskEvent(saved_task: Task): Promise<void> {
    const event = await this.eventRepository.findOneBy({
      type: EventTypes.NEW_TASK,
      task: { id: saved_task.id },
    });

    if (!event) {
      return;
    }

    event.before_state = event.after_state;
    event.after_state = EventWrapper.fromEntity(saved_task);

    await this.eventRepository.save(event);
  }

  /**
   * Remaps event to different deal.
   * Only works with events of type EventTypes.NEW_EMAIL and EventTypes.NEW_TELEGRAM_MESSAGE.
   */
  /**
   * Moves an email or a Telegram message (with its files) from one deal to another,
   * e.g. a message that the inbox put into the contact's latest deal but belongs to an
   * older one. Allowed when the user may edit both deals (the "update" deal permission:
   * admin and a user with "all" every deal, "responsible" only their own deals; without
   * stored permissions a manager every deal, an agent their own).
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
        event.after_state = EventWrapper.fromEntity(savedEmail);
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

    await this.eventRepository.save(event);
  }

  private canEditDeal(user: AuthUser, deal: Deal): boolean {
    if (user.role === RoleEnum.ADMIN) return true;
    const level = (user.permissions as any)?.deal?.update;
    const own = deal.agent?.id === user.sub;
    if (typeof level !== 'number') return user.role === RoleEnum.MANAGER || own;
    if (level === 3) return true; // allowed
    if (level === 2) return own || (user.group_id != null && deal.agent?.group?.id === user.group_id);
    if (level === 1) return own; // responsible
    return false;
  }

  async markAsReplied(event_id: number): Promise<void> {
    const result = await this.eventRepository
      .createQueryBuilder()
      .update(Event)
      .where({ id: event_id })
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

    commentEvent.before_state = commentEvent.after_state;
    commentEvent.after_state = EventWrapper.fromEntity({
      comment: data.comment,
      files: [...commentEvent.after_state.data.files, ...files],
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
