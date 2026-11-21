import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Trigger, TriggerTypes } from './trigger.entity';
import { DataSource, Repository } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { TaskEventDto } from '../events/dto/task.event.dto';
import { EventTypes, FieldsOf } from '../events/event.entity';
import { User } from '../user/user.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Task } from '../task/task.entity';
import { TaskType } from '../task_type/task_type.entity';
import { FileService } from '../file/file.service';
import { HelperService } from '../helper/helper.service';
import {
  ChangeAgentContents,
  ChangeFieldContents,
  CloseTaskContents,
  CreateDealContents,
  CreateTaskContents,
  DealFilter,
  DeleteFilesContents,
  SendEmailContents,
  TaskResponsible,
  TaskResponsibleEnum,
  WithTaskEndTimeEnum,
} from './dto/assign.trigger.dto';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { DealStageRecord } from '../deal_stage/deal_stage.records.entity';
import { LoggerService } from '../helper/logger.service';
import { File } from '../file/file.entity';
import { EmailService } from '../email/email.service';
import { SendEmailDto } from '../email/dto/send.email.dto';
import { EmailTemplate } from '../email/email.template.entity';
import { DealFiller } from '../deal/deal.filler.entity';
import { Filler } from '../filler/filler.entity';
import { Field, FieldValueEventDto } from '../events/dto/field.value.event.dto';
import { NotificationGateWay } from '../gateway/notification.gateway';

// a "create deal" trigger may start a chain: a copy never creates further copies
const MAX_CREATE_DEAL_DEPTH = 1;

/**
 * A "create deal" trigger made `deal` in `stage`: the caller gives it the triggers of
 * that stage (TriggerService.onDealEnteredStage) one level deeper (`depth`).
 */
export type OnDealCreated = (
  originatedBy: User,
  deal: Deal,
  stage: DealStage,
  depth: number,
) => Promise<void>;

/**
 * What a trigger does to a deal: create or close tasks, change fields or the
 * responsible, delete files, send an email, create a copy of the deal.
 * When triggers fire and the schedule in `trigger_run` are TriggerService's.
 */
@Injectable()
export class TriggerActionsService {
  private readonly logger = new Logger(TriggerActionsService.name);

  constructor(
    @InjectRepository(Task)
    private taskRepository: Repository<Task>,
    @InjectRepository(Deal)
    private dealRepository: Repository<Deal>,
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
    private fileService: FileService,
    private emailService: EmailService,
    private helperService: HelperService,
    private loggerService: LoggerService,
    private notificationGateway: NotificationGateWay,
  ) {}

  /** Executes one trigger for one deal now. Throws on failure (the caller records it). */
  async executeTrigger(
    originatedBy: User,
    deal: Deal,
    trigger: Trigger,
    depth: number,
    onDealCreated: OnDealCreated,
  ): Promise<void> {
    this.loggerService.log(`Executing trigger ${trigger.id} (type ${trigger.type}) for deal ${deal.id}`);
    const filters = trigger.deal_filters ?? [];

    switch (trigger.type) {
      case TriggerTypes.CREATE_TASK:
        return this.handleCreateTask(deal, trigger.data, filters, originatedBy);
      case TriggerTypes.CHANGE_FIELDS:
        return this.handelChangeField(deal, trigger.data, filters, originatedBy);
      case TriggerTypes.DELETE_FILES:
        return this.handleDeleteFiles(deal, trigger.data, filters);
      case TriggerTypes.CLOSE_TASKS:
        return this.handleCloseTasks(deal, trigger.data, filters, originatedBy);
      case TriggerTypes.CHANGE_AGENT:
        return this.handleChangeAgent(deal, trigger.data, filters, originatedBy);
      case TriggerTypes.SEND_EMAIL:
        return this.handleSendEmail(deal, trigger.data, filters);
      case TriggerTypes.CREATE_DEAL:
        return this.handleCreateDeal(deal, trigger.data, filters, originatedBy, depth, onDealCreated);
    }
  }

  /**
   * The deal, if it fits the filters of the trigger ("для всех сделок у которых ..."),
   * with the given relations loaded; null otherwise.
   */
  private async getTargetDeal(deal: Deal, filters: DealFilter[] = [], relations: string[] = []): Promise<Deal | null> {
    let qb = this.dealRepository.createQueryBuilder('t0').where('t0.id = :deal_id', { deal_id: deal.id });

    let n = 0;
    for (const filter of filters) {
      n++;
      const value = filter.value === null || filter.value === undefined ? '' : String(filter.value);
      if (filter.is_filler) {
        qb = qb.andWhere(
          `EXISTS (SELECT 1 FROM deal_filler df${n} INNER JOIN filler fl${n} ON fl${n}.id = df${n}.filler_id
                    WHERE df${n}.deal_id = t0.id AND fl${n}.field = :field${n} AND df${n}.value = :value${n})`,
          { [`field${n}`]: filter.field, [`value${n}`]: value },
        );
      } else {
        if (!/^[a-z_][a-z0-9_]*$/.test(filter.field)) {
          throw new BadRequestException(`Invalid deal filter field: ${filter.field}`);
        }
        qb = qb.andWhere(`CAST(t0.${filter.field} AS TEXT) = :value${n}`, { [`value${n}`]: value });
      }
    }

    const aliases = new Map<string, string>([['', 't0']]);
    let r = 0;
    for (const relation of relations) {
      const parts = relation.split('.');
      const parent = parts.slice(0, -1).join('.');
      if (aliases.has(relation)) continue;
      const alias = `r${++r}`;
      qb = qb.leftJoinAndSelect(`${aliases.get(parent)}.${parts[parts.length - 1]}`, alias);
      aliases.set(relation, alias);
    }

    return qb.getOne();
  }

  private async handleCreateTask(
    deal: Deal,
    data: CreateTaskContents,
    filters: DealFilter[],
    originatedBy: User,
  ): Promise<void> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['created_by', 'agent', 'company']);
    if (!targetDeal) return;

    const responsible = await this.getTaskResponsible(targetDeal, data.responsible, originatedBy);
    const type = data.type_id ? await this.helperService.getById(TaskType, data.type_id) : null;

    const newTask = new Task();
    newTask.agent = responsible;
    newTask.created_by = targetDeal.created_by ?? originatedBy ?? targetDeal.agent;
    newTask.deal = targetDeal;
    newTask.company = targetDeal.company ?? null;
    newTask.type = type;
    newTask.allDay = !!data.all_day;
    newTask.start_time = new Date();
    newTask.end_time = this.getCloseTaskDate(Number(data.end_time_in_minutes ?? 0));
    newTask.label = (data.label || '').trim() || 'Задача по триггеру';

    const saved = await this.taskRepository.save(newTask);

    const eventData: TaskEventDto = {
      task: saved,
      deal: targetDeal,
      originated_by: newTask.created_by,
    };
    this.eventEmitter.emit(EventTypes.NEW_TASK.toString(), eventData);
    try {
      this.notificationGateway.sendNotification(JSON.stringify(saved));
    } catch (error) {
      this.logger.warn(`notification about task ${saved.id} failed: ${(error as Error).message}`);
    }
  }

  private getCloseTaskDate(closeTaskInMinutes: number): Date {
    const newDate = new Date();
    newDate.setMinutes(newDate.getMinutes() + closeTaskInMinutes);
    return newDate;
  }

  private async getTaskResponsible(deal: Deal, data: TaskResponsible, originatedBy: User): Promise<User> {
    if (data?.exact_user_id) {
      return this.helperService.getById(User, data.exact_user_id);
    }
    // the frontend used to send "created" for the creator
    if (data?.user === TaskResponsibleEnum.CREATOR || (data?.user as string) === 'created') {
      return deal.created_by ?? deal.agent ?? originatedBy;
    }
    return deal.agent ?? deal.created_by ?? originatedBy;
  }

  private async handleDeleteFiles(deal: Deal, data: DeleteFilesContents, filters: DealFilter[]): Promise<void> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['files', 'files.deals', 'files.email']);
    if (!targetDeal) return;

    for (const file of targetDeal.files ?? []) {
      if (this.fileFitsExtensionFilter(data, file)) {
        await this.fileService.deleteFileFromEntity(file, targetDeal.id);
      }
    }
  }

  fileFitsExtensionFilter(data: DeleteFilesContents, file: File): boolean {
    const extensions = (data.with_extensions ?? []).map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase());
    const sources = data.which_files ?? [];
    // no filters at all: the trigger deletes nothing (a safety net)
    if (extensions.length === 0 && sources.length === 0 && !data.till_bytes && !data.from_bytes) {
      return false;
    }
    if (extensions.length > 0 && !extensions.includes((file.extension ?? '').toLowerCase())) {
      return false;
    }
    if (sources.length > 0 && !sources.includes(file.from)) {
      return false;
    }
    if (data.till_bytes && Number(file.size) > data.till_bytes) {
      return false;
    }
    if (data.from_bytes && Number(file.size) < data.from_bytes) {
      return false;
    }
    return true;
  }

  private async handleChangeAgent(
    deal: Deal,
    data: ChangeAgentContents,
    filters: DealFilter[],
    originatedBy: User,
  ): Promise<void> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['agent']);
    if (!targetDeal) return;

    const agent = await this.helperService.getById(User, data.agent_id);
    if (targetDeal.agent?.id === agent.id) return;
    const old = targetDeal.agent?.id;
    targetDeal.agent = agent;
    await this.dealRepository.save(targetDeal);
    this.emitFieldChanges(targetDeal, originatedBy ?? agent, [new Field('agent_id', String(agent.id), old ? String(old) : null)]);
  }

  private async handelChangeField(
    deal: Deal,
    data: ChangeFieldContents,
    filters: DealFilter[],
    originatedBy: User,
  ): Promise<void> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['deal_fillers', 'deal_fillers.filler', 'agent']);
    if (!targetDeal) return;

    const changes: Field[] = [];
    const fillerRepository = this.dataSource.getRepository(Filler);
    const dealFillerRepository = this.dataSource.getRepository(DealFiller);

    for (const fieldData of data.fields ?? []) {
      const value = fieldData.value === null || fieldData.value === undefined ? '' : String(fieldData.value);
      if (fieldData.is_filler) {
        const existing = (targetDeal.deal_fillers ?? []).find((df) => df.filler?.field === fieldData.field);
        if (existing) {
          if (existing.value === value) continue;
          changes.push(new Field(fieldData.field, value, existing.value));
          existing.value = value;
          await dealFillerRepository.save(existing);
        } else {
          const filler = await fillerRepository.findOne({ where: { target: 'deal', field: fieldData.field } });
          if (!filler) continue;
          const dealFiller = new DealFiller();
          dealFiller.deal = targetDeal;
          dealFiller.filler = filler;
          dealFiller.value = value;
          await dealFillerRepository.save(dealFiller);
          // Deal.deal_fillers cascades: a saved deal whose array lacks the new row would orphan it
          targetDeal.deal_fillers = [...(targetDeal.deal_fillers ?? []), dealFiller];
          changes.push(new Field(fieldData.field, value, null));
        }
        continue;
      }

      switch (fieldData.field) {
        case 'agent_id': {
          const agent = await this.helperService.getById(User, Number(value));
          if (targetDeal.agent?.id === agent.id) continue;
          changes.push(new Field('agent_id', String(agent.id), targetDeal.agent ? String(targetDeal.agent.id) : null));
          targetDeal.agent = agent;
          break;
        }
        case 'budget': {
          const budget = Number(value);
          if (!Number.isFinite(budget)) throw new BadRequestException(`Budget "${value}" is not a number`);
          if (Number(targetDeal.budget) === budget) continue;
          changes.push(new Field('budget', String(budget), targetDeal.budget === null ? null : String(targetDeal.budget)));
          targetDeal.budget = budget;
          break;
        }
        case 'label': {
          if (!value.trim()) continue;
          if (targetDeal.label === value) continue;
          changes.push(new Field('label', value, targetDeal.label));
          targetDeal.label = value;
          break;
        }
        default:
          this.logger.warn(`change fields: "${fieldData.field}" is not a field a trigger may change`);
      }
    }

    if (changes.length === 0) return;
    await this.dealRepository.save(targetDeal);
    this.emitFieldChanges(targetDeal, originatedBy ?? targetDeal.agent, changes);
  }

  private emitFieldChanges(deal: Deal, originatedBy: User, fields: Field[]): void {
    if (!originatedBy || fields.length === 0) return;
    const eventData: FieldValueEventDto = {
      originated_by: originatedBy,
      deal,
      fields,
      fields_of: FieldsOf.DEAL,
    };
    this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), eventData);
  }

  private async handleCloseTasks(
    deal: Deal,
    data: CloseTaskContents,
    filters: DealFilter[],
    originatedBy: User,
  ): Promise<void> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['tasks', 'tasks.type', 'tasks.agent', 'agent']);
    if (!targetDeal || !targetDeal.tasks?.length) return;

    const result = (data.result || '').trim() || 'Закрыто триггером';
    const updatedTasks: Task[] = [];
    for (const task of targetDeal.tasks) {
      if (task.closed_at) continue;
      if (data.type_id && data.type_id !== task.type?.id) continue;
      if (!this.taskFitsDateFilter(data.with_task_end_times ?? [], task.end_time)) continue;

      task.closed_at = new Date();
      task.result = result;
      updatedTasks.push(task);
    }
    if (updatedTasks.length === 0) return;
    await this.taskRepository.save(updatedTasks);

    for (const task of updatedTasks) {
      const eventData: TaskEventDto = {
        task,
        deal: targetDeal,
        originated_by: originatedBy ?? targetDeal.agent ?? task.agent,
      };
      this.eventEmitter.emit(EventTypes.NEW_TASK_STATUS.toString(), eventData);
    }
  }

  /** True if at least one of the filters applies ("all" = every task). */
  private taskFitsDateFilter(filters: WithTaskEndTimeEnum[], endTime: Date): boolean {
    if (filters.length === 0) return true;
    const today = new Date();
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    for (const filter of filters) {
      switch (filter) {
        case WithTaskEndTimeEnum.ALL:
          return true;
        case WithTaskEndTimeEnum.TODAY:
          if (endTime && sameDay(endTime, today)) return true;
          break;
        case WithTaskEndTimeEnum.TOMORROW:
          if (endTime && sameDay(endTime, tomorrow)) return true;
          break;
        case WithTaskEndTimeEnum.OVERDUE:
          if (endTime && endTime < today) return true;
          break;
      }
    }
    return false;
  }

  private async handleSendEmail(deal: Deal, data: SendEmailContents, filters: DealFilter[]): Promise<void> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['created_by', 'agent', 'ctr_agents']);
    if (!targetDeal) return;

    const template = await this.helperService.getById(EmailTemplate, data.template_id);

    // a chosen user, else every contact of the deal with an email
    const recipients = data.send_to_user_id
      ? [(await this.helperService.getById(User, data.send_to_user_id)).email]
      : (targetDeal.ctr_agents ?? []).map((c) => c.email);
    const to = recipients.filter((email) => !!email && /@/.test(email));
    if (to.length === 0) {
      throw new Error(`deal ${targetDeal.id}: no recipient with an email address`);
    }

    const sendEmailDto = new SendEmailDto();
    sendEmailDto.body = template.template_body;
    sendEmailDto.subject = template.subject ?? template.name ?? '';
    sendEmailDto.to = to;

    const originatedBy =
      data.from === TaskResponsibleEnum.CREATOR
        ? targetDeal.created_by ?? targetDeal.agent
        : targetDeal.agent ?? targetDeal.created_by;

    await this.emailService.sendEmail(sendEmailDto, originatedBy);
  }

  /**
   * "Создать сделку": a copy of the deal (client, company, responsible) in another stage.
   * The copy gets the triggers of its stage (`onDealCreated`), but never another copy (depth limit).
   */
  private async handleCreateDeal(
    deal: Deal,
    data: CreateDealContents,
    filters: DealFilter[],
    originatedBy: User,
    depth: number,
    onDealCreated: OnDealCreated,
  ): Promise<void> {
    if (depth >= MAX_CREATE_DEAL_DEPTH) {
      this.logger.warn(`create deal trigger skipped for deal ${deal.id}: a copy of a copy`);
      return;
    }
    const targetDeal = await this.getTargetDeal(deal, filters, ['agent', 'company', 'ctr_agents', 'created_by']);
    if (!targetDeal) return;

    const stage = await this.helperService.getById(DealStage, data.stage_id);
    const newDeal = new Deal();
    newDeal.label = (data.label || '').trim() || `${targetDeal.label} (копия)`;
    newDeal.budget = targetDeal.budget;
    newDeal.agent = targetDeal.agent;
    newDeal.company = targetDeal.company;
    newDeal.ctr_agents = targetDeal.ctr_agents ?? [];
    newDeal.created_by = originatedBy ?? targetDeal.created_by ?? targetDeal.agent;
    newDeal.stage = stage;
    newDeal.last_stage_change = new Date();
    // the next sequential number is given while saving
    const saved = await this.helperService.saveNewDeal(newDeal);

    const record = new DealStageRecord();
    record.deal = saved;
    record.stage = stage;
    await this.dataSource.getRepository(DealStageRecord).save(record);

    this.eventEmitter.emit(EventTypes.NEW_DEAL.toString(), { deal: saved });
    await onDealCreated(newDeal.created_by, saved, stage, depth + 1);
  }

  /** Minutes from `lastStageChangeDate` to `inputDate` (kept for the old callers). */
  differenceInMinutes(inputDate: Date, lastStageChangeDate: Date): number {
    return (inputDate.getTime() - lastStageChangeDate.getTime()) / 60000;
  }
}
