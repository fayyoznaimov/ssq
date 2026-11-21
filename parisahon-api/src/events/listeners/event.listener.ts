import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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
        .addAfterState(EventWrapper.fromEntity(data.task)),
    );
  }

  @OnEvent(EventTypes.NEW_TASK_STATUS.toString())
  async handleNewTaskStatusEvent(data: TaskEventDto): Promise<void> {
    await this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_TASK_STATUS)
        .originatedBy(data.originated_by)
        .addTargetFieldsIfGiven(data)
        .linkToDeal(data.deal)
        .addAfterState(EventWrapper.fromEntity(data.task)),
    );
  }

  @OnEvent(EventTypes.NEW_DEAL.toString())
  async handleNewDealEvent(data: DealEventDto): Promise<void> {
    await this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_DEAL)
        .originatedBy(data.deal.created_by)
        .addTargetUser(data.deal.agent)
        .linkToDeal(data.deal)
        .addAfterState(EventWrapper.fromEntity(data.deal)),
    );
  }

  @OnEvent(EventTypes.NEW_COMPANY.toString())
  async handleNewCompanyEvent(data: CompanyEventDto): Promise<void> {
    await this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_COMPANY)
        .originatedBy(data.originated_by)
        .addTargetFieldsIfGiven(data)
        .linkToDeal(data.deal)
        .addAfterState(EventWrapper.fromEntity(data.company)),
    );
  }

  @OnEvent(EventTypes.NEW_CTR_AGENT.toString())
  async handleNewCtrAgentEvent(data: CtrAgentEventDto): Promise<void> {
    await this.eventRepository.save(
      EventBuilder.fromType(EventTypes.NEW_CTR_AGENT)
        .originatedBy(data.originated_by)
        .addTargetFieldsIfGiven(data)
        .linkToDeal(data.deal)
        .addAfterState(EventWrapper.fromEntity(data.ctr_agent)),
    );
  }

  @OnEvent(EventTypes.NEW_FIELD_VALUE.toString())
  async handleNewFieldValueEvent(data: FieldValueEventDto): Promise<void> {
    const events: Event[] = [];

    data.fields.forEach((field) => {
      if (field.old_value === field.new_value) {
        return;
      }

      let eventBuilder = this.createEventBuilderFromType(field.old_value)
        .originatedBy(data.originated_by)
        .addTargetFieldsIfGiven(data)
        .addFieldOf(data.fields_of)
        .linkToDeal(data.deal);

      const afterState = {
        field: field.name,
        new_value: field.new_value,
      };

      if (field.old_value) {
        afterState['old_value'] = field.old_value;
        eventBuilder = eventBuilder.addBeforeState(
          EventWrapper.fromEntity({
            field: field.name,
            new_value: field.old_value,
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
      delete emailEvent.email.from_user.linked_deals;

      emailEvents.push(
        EventBuilder.fromType(EventTypes.NEW_EMAIL)
          .originatedBy(emailEvent.originated_by)
          .addTargetFieldsIfGiven(emailEvent)
          .linkToDeal(emailEvent.deal)
          .addCreatedAt(emailEvent.email.sent_at)
          .addAfterState(EventWrapper.fromEntity(emailEvent.email)),
      );
    });

    await this.eventRepository.save(emailEvents);
  }

  /** A call recording linked to a deal (CallsService): the same row the Telegram service used to write. */
  @OnEvent(EventTypes.NEW_CALL_RECORDING.toString())
  async handleNewCallRecording(data: CallRecordingEventDto): Promise<void> {
    const event = EventBuilder.fromType(EventTypes.NEW_CALL_RECORDING)
      .originatedBy(data.originated_by)
      .addTargetFieldsIfGiven(data)
      .linkToDeal(data.deal)
      .addAfterState({
        outgoing: data.recording.outgoing,
        path: data.recording.path,
        name: data.recording.path,
      });
    event.outgoing = data.recording.outgoing;
    event.duration = data.recording.duration;
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
              product: eventData.deal_product.product,
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
