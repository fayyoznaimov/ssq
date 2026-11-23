import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { instanceToPlain } from 'class-transformer';
import { Event, EventTypes } from '../event.entity';
import { Repository } from 'typeorm';
import { EventBuilder } from '../event.builder';
import { TaskEventDto } from '../dto/task.event.dto';
import { EventWrapper } from '../event.wrapper';
import { DealEventDto } from '../dto/deal.event.dto';
import { CompanyEventDto } from '../dto/company.event';
import { CtrAgentEventDto } from '../dto/ctr.agent.event.dto';
import { FieldValueEventDto } from '../dto/field.value.event.dto';
import { EmailEventDto } from '../dto/email.event.dto';
import { CallRecordingEventDto } from '../dto/call.recording.event.dto';
import { TelegramMessageEvent } from '../dto/telegram.message.event';
import { ProductEventDto } from '../dto/product.event.dto';
import { DealStageEventDto } from '../dto/deal.stage.event.dto';

/**
 * Writes the history (the `event` rows) from what the services emit.
 *
 * The history keeps what it needs to show an event, not whole accounts: a person is
 * {id, username, role, avatar} (the rights, goals, Telegram id and contacts of an employee stay
 * out of every deal's history, AUDIT-15), a deal, company or contact its own values without
 * their relations.
 */
@Injectable()
export class EventListener {
  constructor(
    @InjectRepository(Event)
    private eventRepository: Repository<Event>,
  ) {}

  @OnEvent(EventTypes.NEW_TASK.toString())
  async handleNewTaskEvent(data: TaskEventDto): Promise<void> {
    await this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_TASK)
        .originatedBy(data.originated_by)
        .addTargetFieldsIfGiven(data)
        .addTask(data.task)
        .linkToDeal(data.deal)
        .addAfterState(EventListener.taskState(data.task)),
    );
  }

  @OnEvent(EventTypes.NEW_TASK_STATUS.toString())
  async handleNewTaskStatusEvent(data: TaskEventDto): Promise<void> {
    await this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_TASK_STATUS)
        .originatedBy(data.originated_by)
        .addTargetFieldsIfGiven(data)
        // the task of the closing too: a task of a company or a contact (no deal) is in their feeds
        .addTask(data.task)
        .linkToDeal(data.deal)
        .addAfterState(EventListener.taskState(data.task)),
    );
  }

  /** A person in the history: who it was, not their whole account. */
  static person(user: any): Record<string, any> | null {
    if (!user || typeof user !== 'object') return null;
    const out: Record<string, any> = { id: user.id ?? null, username: user.username ?? null };
    if (user.role) out.role = user.role;
    if (user.avatar) out.avatar = user.avatar;
    return out;
  }

  /** The own values of a record (numbers, texts, dates), without its relations. */
  static plain(entity: any): Record<string, any> {
    const out: Record<string, any> = {};
    const source = entity && typeof entity === 'object' ? (instanceToPlain(entity) as Record<string, any>) : {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (value === null || typeof value !== 'object' || value instanceof Date) out[key] = value;
    }
    return out;
  }

  private static ref(entity: any, keys: string[]): Record<string, any> | null {
    if (!entity || typeof entity !== 'object') return null;
    const out: Record<string, any> = {};
    for (const key of keys) out[key] = entity[key] ?? null;
    return out;
  }

  /** The task as the history keeps it; a task without a type gets a neutral one (the web client reads type.name). */
  static taskState(task: any): Record<string, any> {
    const data = EventListener.plain(task);
    data.type = EventListener.ref(task?.type, ['id', 'name']) ?? { id: null, name: 'Задача' };
    if (!data.type.name) data.type.name = 'Задача';
    data.agent = EventListener.person(task?.agent);
    data.group = EventListener.ref(task?.group, ['id', 'name']);
    data.created_by = EventListener.person(task?.created_by);
    data.deal = EventListener.ref(task?.deal, ['id', 'label', 'display_id']);
    data.company = EventListener.ref(task?.company, ['id', 'name']);
    data.ctr_agent = EventListener.person(task?.ctr_agent);
    return EventWrapper.fromEntity(data);
  }

  /** A new deal: its values, who is responsible, the client and the products (names, not accounts). */
  static dealState(deal: any): Record<string, any> {
    const data = EventListener.plain(deal);
    data.stage = EventListener.ref(deal?.stage, ['id', 'name', 'color']);
    data.agent = EventListener.person(deal?.agent);
    data.created_by = EventListener.person(deal?.created_by);
    data.company = EventListener.ref(deal?.company, ['id', 'name']);
    data.ctr_agents = (deal?.ctr_agents ?? []).filter(Boolean).map((c: any) => EventListener.person(c));
    data.products = (deal?.deal_products ?? []).filter(Boolean).map((p: any) => ({
      product: EventListener.ref(p.product, ['id', 'name']),
      quantity: p.quantity ?? null,
      price: p.price ?? null,
    }));
    return EventWrapper.fromEntity(data);
  }

  @OnEvent(EventTypes.NEW_DEAL.toString())
  async handleNewDealEvent(data: DealEventDto): Promise<void> {
    await this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_DEAL)
        .originatedBy(data.deal.created_by)
        .addTargetUser(data.deal.agent)
        .linkToDeal(data.deal)
        .addAfterState(EventListener.dealState(data.deal)),
    );
  }

  @OnEvent(EventTypes.NEW_COMPANY.toString())
  async handleNewCompanyEvent(data: CompanyEventDto): Promise<void> {
    await this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_COMPANY)
        .originatedBy(data.originated_by)
        .addTargetFieldsIfGiven(data)
        .linkToDeal(data.deal)
        .addAfterState(EventWrapper.fromEntity(EventListener.plain(data.company))),
    );
  }

  @OnEvent(EventTypes.NEW_CTR_AGENT.toString())
  async handleNewCtrAgentEvent(data: CtrAgentEventDto): Promise<void> {
    const contact = EventListener.plain(data.ctr_agent);
    contact.company = EventListener.ref((data.ctr_agent as any)?.company, ['id', 'name']);
    await this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_CTR_AGENT)
        .originatedBy(data.originated_by)
        .addTargetFieldsIfGiven(data)
        .linkToDeal(data.deal)
        .addAfterState(EventWrapper.fromEntity(contact)),
    );
  }

  /** "null" / "undefined" of a value turned into a string ("${deal.budget}") is no value. */
  private static value(value: any): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value);
    return text === 'null' || text === 'undefined' ? null : text;
  }

  /** Names of the employees whose ids a field change holds (the responsible of a deal: "agent_id"). */
  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const numbers = [...new Set(ids.filter((id) => id && /^\d{1,9}$/.test(id)).map(Number))];
    if (!numbers.length) return new Map();
    const rows: { id: number; username: string }[] = await this.eventRepository.query(
      `SELECT id, username FROM "user" WHERE id = ANY($1::int[])`,
      [numbers],
    );
    return new Map(rows.map((r) => [String(r.id), r.username]));
  }

  @OnEvent(EventTypes.NEW_FIELD_VALUE.toString())
  async handleNewFieldValueEvent(data: FieldValueEventDto): Promise<void> {
    const events: Event[] = [];
    const people = await this.names(
      data.fields
        .filter((field) => field.name === 'agent_id')
        .flatMap((field) => [EventListener.value(field.old_value), EventListener.value(field.new_value)]),
    );

    data.fields.forEach((field) => {
      const oldValue = EventListener.value(field.old_value);
      const newValue = EventListener.value(field.new_value);
      if (oldValue === newValue) {
        return;
      }

      let eventBuilder = this.createEventBuilderFromType(oldValue)
        .originatedBy(data.originated_by)
        .addTargetFieldsIfGiven(data)
        .addFieldOf(data.fields_of)
        .linkToDeal(data.deal);

      const afterState = {
        field: field.name,
        new_value: newValue,
      };
      // the product a quantity or a price is of (the feed said «Количество товара: 2 → 3» of which one?)
      if (field.subject) afterState['subject'] = field.subject;
      // the responsible of a deal is stored by id: the names too, for the feed
      if (field.name === 'agent_id') {
        afterState['new_label'] = people.get(String(newValue)) ?? null;
        if (oldValue) afterState['old_label'] = people.get(String(oldValue)) ?? null;
      }

      if (oldValue) {
        afterState['old_value'] = oldValue;
        eventBuilder = eventBuilder.addBeforeState(
          EventWrapper.fromEntity({
            field: field.name,
            new_value: oldValue,
          }),
        );
      }
      eventBuilder = eventBuilder.addAfterState(
        EventWrapper.fromEntity(afterState),
      );

      events.push(eventBuilder);
    });

    await this.eventRepository.save(events);
  }

  @OnEvent(EventTypes.NEW_EMAIL.toString())
  async handleNewEmailEvent(data: EmailEventDto[]): Promise<void> {
    const emailEvents: Event[] = [];

    data.forEach((emailEvent: EmailEventDto) => {
      if (emailEvent.email?.from_user) delete emailEvent.email.from_user.linked_deals;

      const event = EventBuilder.fromType(EventTypes.NEW_EMAIL)
        .originatedBy(emailEvent.originated_by)
        .addTargetFieldsIfGiven(emailEvent)
        .linkToDeal(emailEvent.deal)
        .addCreatedAt(emailEvent.email.sent_at)
        .addAfterState(EventWrapper.fromEntity(emailEvent.email));
      // the people of the letter by name, not their accounts (AUDIT-15)
      const mail = event.after_state?.data;
      if (mail && typeof mail === 'object') {
        for (const key of ['from_user', 'sent_by', 'deleted_by']) {
          if (mail[key] !== undefined) mail[key] = EventListener.person(mail[key]);
        }
      }
      // the direction of the letter: the column defaults to "outgoing", and the control of answers,
      // "клиент ждёт ответа" and the autopilot read the column (a client's letter was an answer, MAIL-2)
      event.outgoing = Boolean(emailEvent.email?.outgoing);
      emailEvents.push(event);
    });

    await this.eventRepository.save(emailEvents);
  }

  /**
   * A call recording linked to a deal (CallsService, CallDealService). Dated by the call, not by
   * the moment the phone synced it or "Создать сделку" linked it; an outgoing call is from the
   * manager to the client (the services pass the client as originated_by and the manager as the
   * target for both directions).
   */
  @OnEvent(EventTypes.NEW_CALL_RECORDING.toString())
  async handleNewCallRecording(data: CallRecordingEventDto): Promise<void> {
    const recording = data.recording;
    const outgoing = recording.outgoing !== false;
    const manager = data.target_user;
    const client = data.originated_by;
    const managerCalled = outgoing && !!manager;

    // the DTO is shared with the triggers' listener: nothing of it is changed here
    const event = EventBuilder.fromType(EventTypes.NEW_CALL_RECORDING)
      .originatedBy(managerCalled ? manager : client)
      .linkToDeal(data.deal)
      .addCreatedAt(recording.created_at)
      .addAfterState({
        outgoing,
        path: recording.path,
        name: recording.path,
        number: recording.from_number ?? null,
      });
    if (managerCalled) {
      event.addTargetUser(client);
    } else {
      event.addTargetFieldsIfGiven(data);
    }
    event.outgoing = outgoing;
    event.duration = recording.duration;
    await this.eventRepository.save(event);
  }

  @OnEvent(EventTypes.NEW_TELEGRAM_MESSAGE.toString())
  async handleNewTelegramMessage(data: TelegramMessageEvent[]): Promise<void> {
    const events: Event[] = [];
    data.forEach((eventData) => {
      events.push(
        EventBuilder.fromType(EventTypes.NEW_TELEGRAM_MESSAGE)
          .originatedBy(eventData.originated_by)
          .linkToDeal(eventData.deal)
          .addAfterState(
            EventWrapper.fromEntity({
              files: eventData.files,
              message: eventData.message,
              outgoing: true,
              to_user_id: eventData.to_user.id,
              from_user_id: eventData.from_user.id,
              contact: null, // To be implemented
              location: eventData.location,
            }),
          ),
      );
    });

    await this.eventRepository.save(events);
  }

  @OnEvent(EventTypes.NEW_PRODUCT.toString())
  async handleNewProduct(data: ProductEventDto[]): Promise<void> {
    const events: Event[] = [];

    data.forEach((eventData) => {
      events.push(
        EventBuilder.fromType(EventTypes.NEW_PRODUCT)
          .originatedBy(eventData.originated_by)
          .linkToDeal(eventData.deal ?? eventData.deal_product.deal)
          .addAfterState(
            EventWrapper.fromEntity({
              product: EventListener.ref(eventData.deal_product.product, ['id', 'name']),
              price: eventData.deal_product.price,
              quantity: eventData.deal_product.quantity,
            }),
          ),
      );
    });

    await this.eventRepository.save(events);
  }

  @OnEvent(EventTypes.NEW_DEAL_STAGE.toString())
  async handleNewDealStage(data: DealStageEventDto): Promise<void> {
    /**
     * Removing some redundant data
     */
    delete data.new_stage.triggers;
    delete data.new_stage.deals;
    // A deal may have had no stage before
    if (data.old_stage) {
      delete data.old_stage.triggers;
      delete data.old_stage.deals;
    }

    const event = EventBuilder.fromType(EventTypes.NEW_DEAL_STAGE)
      .originatedBy(data.originated_by)
      .linkToDeal(data.deal)
      .addAfterState(
        EventWrapper.fromEntity({
          stage: data.new_stage,
        }),
      )
      .addBeforeState(
        EventWrapper.fromEntity({
          stage: data.old_stage,
        }),
      );

    await this.eventRepository.save(event);
  }

  private createEventBuilderFromType(oldValue?: string): EventBuilder {
    if (oldValue) {
      return EventBuilder.fromType(EventTypes.NEW_UPDATED_FIELD_VALUE);
    }

    return EventBuilder.fromType(EventTypes.NEW_FIELD_VALUE);
  }
}
