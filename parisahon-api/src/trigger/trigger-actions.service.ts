import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Trigger, TriggerTypes } from './trigger.entity';
import { DataSource, Repository } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { TaskEventDto } from '../events/dto/task.event.dto';
import { Event, EventTypes, FieldsOf } from '../events/event.entity';
import { EventBuilder } from '../events/event.builder';
import { EventWrapper } from '../events/event.wrapper';
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
import { defaultTaskType } from '../task_type/default-task-type';
import { WorkSchedule } from '../analytics/control.service';
import { endOfWorkingDay } from '../automation/autopilot.service';

// a "create deal" trigger may start a chain: a copy never creates further copies
const MAX_CREATE_DEAL_DEPTH = 1;
const DAY_MINUTES = 24 * 60;
// the letters of "send email": automatic, answering machines must not reply (RFC 3834; Exchange / Outlook)
const AUTOMATIC_LETTER_HEADERS: Record<string, string> = {
  'Auto-Submitted': 'auto-generated',
  'X-Auto-Response-Suppress': 'All',
};

/**
 * What one execution did: `done` (the note says what, for the history of the trigger) or
 * `skipped` on purpose (the note is the reason: the deal does not fit the conditions, ...).
 * A failure is an exception, not an outcome.
 */
export interface TriggerOutcome {
  status: 'done' | 'skipped';
  note?: string;
}

const done = (note?: string): TriggerOutcome => ({ status: 'done', note });
const skipped = (note: string): TriggerOutcome => ({ status: 'skipped', note });
export const NOT_FITTING = 'сделка не подходит под условия триггера';

/** The actions as the settings page names them (the notes in the deal history, the messages to the admins). */
export const ACTION_NAMES: Record<number, string> = {
  [TriggerTypes.CREATE_TASK]: 'Создать задачу',
  [TriggerTypes.CREATE_DEAL]: 'Создать сделку',
  [TriggerTypes.SEND_EMAIL]: 'Отправить письмо',
  [TriggerTypes.CLOSE_TASKS]: 'Завершить задачи',
  [TriggerTypes.CHANGE_AGENT]: 'Сменить ответственного',
  [TriggerTypes.CHANGE_FIELDS]: 'Изменить поле',
  [TriggerTypes.DELETE_FILES]: 'Удалить файлы',
};

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
 * Every action says what it did (TriggerOutcome), so the history of the trigger
 * tells «выполнен» from «сделка не подошла». When triggers fire, how often and
 * the schedule in `trigger_run` are TriggerService's.
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
  ): Promise<TriggerOutcome> {
    this.loggerService.log(`Executing trigger ${trigger.id} (type ${trigger.type}) for deal ${deal.id}`);
    const filters = trigger.deal_filters ?? [];
    // a condition on a deleted field can never hold: a failed run says so (and the admins hear of it)
    const gone = await this.goneFields(filters);
    if (gone.length) {
      throw new Error(`условие триггера на поле сделки, которого больше нет: ${gone.join(', ')} — исправьте условия триггера`);
    }

    switch (trigger.type) {
      case TriggerTypes.CREATE_TASK:
        return this.handleCreateTask(deal, trigger.data, filters, originatedBy);
      case TriggerTypes.CHANGE_FIELDS:
        return this.handelChangeField(deal, trigger.data, filters, originatedBy);
      case TriggerTypes.DELETE_FILES:
        return this.handleDeleteFiles(deal, trigger.data, filters, trigger.deal_stage?.name);
      case TriggerTypes.CLOSE_TASKS:
        return this.handleCloseTasks(deal, trigger.data, filters, originatedBy);
      case TriggerTypes.CHANGE_AGENT:
        return this.handleChangeAgent(deal, trigger.data, filters, originatedBy);
      case TriggerTypes.SEND_EMAIL:
        return this.handleSendEmail(deal, trigger.data, filters);
      case TriggerTypes.CREATE_DEAL:
        return this.handleCreateDeal(deal, trigger.data, filters, originatedBy, depth, onDealCreated);
      default:
        throw new Error(`unknown trigger type ${trigger.type}`);
    }
  }

  /**
   * Why the trigger would do nothing for the deal now (null = it would act): the deal does not fit
   * the conditions, or a "create task" finds the same task still open in the deal. An event trigger
   * asks first, so that a message which does not concern it leaves no row in the history.
   */
  async precheck(deal: Deal, trigger: Trigger): Promise<string | null> {
    // a condition on a deleted field: not "does not fit" in silence, the execution fails visibly
    if ((await this.goneFields(trigger.deal_filters ?? [])).length) return null;
    if (!(await this.getTargetDeal(deal, trigger.deal_filters ?? []))) return NOT_FITTING;
    if (trigger.type === TriggerTypes.CREATE_TASK) {
      const open = await this.openSameTask(deal.id, trigger.data as CreateTaskContents);
      if (open) return open;
    }
    return null;
  }

  /** The custom fields named in the conditions that do not exist any more (deleted), by id, else by name. */
  private async goneFields(filters: DealFilter[]): Promise<string[]> {
    const custom = (filters ?? []).filter((f) => f?.is_filler);
    if (custom.length === 0) return [];
    const ids = custom.map((f) => Number(f.filler_id)).filter((id) => Number.isInteger(id) && id > 0);
    const names = custom.filter((f) => !f.filler_id).map((f) => String(f.field ?? ''));
    const rows: { id: number; field: string }[] = await this.dataSource.query(
      `SELECT id, field FROM filler WHERE target = 'deal' AND (id = ANY($1::int[]) OR field = ANY($2::text[]))`,
      [ids, names],
    );
    return custom
      .filter((f) =>
        f.filler_id
          ? !rows.some((r) => Number(r.id) === Number(f.filler_id))
          : !rows.some((r) => r.field === f.field),
      )
      .map((f) => f.field);
  }

  /** «уже есть открытая задача …» when the deal has an open task of this type and label (made by this trigger before). */
  private async openSameTask(dealId: number, data: CreateTaskContents): Promise<string | null> {
    const label = TriggerActionsService.taskLabel(data);
    const type = data?.type_id ? Number(data.type_id) : (await defaultTaskType(this.taskRepository.manager)).id;
    const rows = await this.dataSource.query(
      `SELECT id FROM task WHERE deal_id = $1 AND closed_at IS NULL AND type_id = $2 AND label = $3 LIMIT 1`,
      [dealId, type, label],
    );
    return rows.length ? `в сделке уже есть открытая задача «${label}»` : null;
  }

  private static taskLabel(data: CreateTaskContents): string {
    return ((data?.label || '').trim() || 'Задача по триггеру').slice(0, 255);
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
      if (filter.is_filler && filter.filler_id) {
        // by id: a renamed custom field keeps its triggers
        qb = qb.andWhere(
          `EXISTS (SELECT 1 FROM deal_filler df${n} WHERE df${n}.deal_id = t0.id AND df${n}.filler_id = :filler${n} AND df${n}.value = :value${n})`,
          { [`filler${n}`]: Number(filter.filler_id), [`value${n}`]: value },
        );
      } else if (filter.is_filler) {
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
  ): Promise<TriggerOutcome> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['created_by', 'agent', 'company']);
    if (!targetDeal) return skipped(NOT_FITTING);
    // six messages of the client are one task «ответить», not six
    const open = await this.openSameTask(targetDeal.id, data);
    if (open) return skipped(open);

    const responsible = await this.getTaskResponsible(targetDeal, data.responsible, originatedBy);
    // a task without a type breaks the task board and the deal history in the web client
    const type = data.type_id
      ? await this.helperService.getById(TaskType, data.type_id)
      : await defaultTaskType(this.taskRepository.manager);

    const now = new Date();
    const newTask = new Task();
    newTask.agent = responsible;
    newTask.created_by = targetDeal.created_by ?? originatedBy ?? targetDeal.agent;
    newTask.deal = targetDeal;
    newTask.company = targetDeal.company ?? null;
    newTask.type = type;
    // «Конец дня» is due at the end of the working day, not for the whole day
    newTask.allDay = !!data.all_day && !TriggerActionsService.isEndOfDay(data);
    newTask.start_time = now;
    newTask.end_time = TriggerActionsService.taskDeadline(data, now);
    newTask.label = TriggerActionsService.taskLabel(data);

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
    const due = saved.end_time.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return done(`создана задача «${saved.label}» для ${responsible?.username ?? 'ответственного'}, срок ${due}`);
  }

  /**
   * When a task of a trigger is due, in working time (CONTROL_WORK_HOURS / CONTROL_WORK_DAYS):
   *  - «Конец дня» (deadline end_of_working_day; the web client of before sent 1440 minutes and
   *    all day): the end of today's working day, or of the next working day when less than half an
   *    hour of today's is left;
   *  - whole days («через день», «через 3 дня», «в течение недели»): the end of the working day
   *    that many days later (a day off moves it to the next working day), never at night;
   *  - other minutes: exactly that much later; 0 = at the moment of the event.
   */
  static taskDeadline(data: CreateTaskContents, now = new Date(), schedule = new WorkSchedule()): Date {
    const minutes = Math.max(0, Number(data?.end_time_in_minutes ?? 0) || 0);
    if (TriggerActionsService.isEndOfDay(data)) return endOfWorkingDay(schedule, now, 30 * 60);
    if (minutes >= DAY_MINUTES && minutes % DAY_MINUTES === 0) {
      const days = minutes / DAY_MINUTES;
      for (let i = 0; i < 8; i++) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days + i);
        const weekday = day.getDay() === 0 ? 7 : day.getDay();
        if (schedule.days.has(weekday)) return new Date(day.getTime() + schedule.endMin * 60000);
      }
    }
    return new Date(now.getTime() + minutes * 60000);
  }

  /** «Конец дня»: end_of_working_day, or how the web client of before sent it (1440 minutes, all day). */
  static isEndOfDay(data: CreateTaskContents): boolean {
    return (
      data?.deadline === 'end_of_working_day' ||
      (Number(data?.end_time_in_minutes ?? 0) === DAY_MINUTES && data?.all_day === true)
    );
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

  private async handleDeleteFiles(
    deal: Deal,
    data: DeleteFilesContents,
    filters: DealFilter[],
    stageName?: string,
  ): Promise<TriggerOutcome> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['files', 'files.deals', 'files.email']);
    if (!targetDeal) return skipped(NOT_FITTING);

    const removed: { id: number; name: string; removed_at: string }[] = [];
    for (const file of targetDeal.files ?? []) {
      if (this.fileFitsExtensionFilter(data, file)) {
        await this.fileService.deleteFileFromEntity(file, targetDeal.id);
        removed.push({ id: file.id, name: file.name, removed_at: new Date().toISOString() });
      }
    }
    if (removed.length === 0) return skipped('в сделке нет файлов по условию');
    const names = removed.map((f) => f.name);
    // the files leave the deal (there is no trash): the deal's history says which ones and why
    // (the feed shows removed_files as «Удалены файлы: …»), the run keeps the list too
    this.logger.log(`trigger deleted ${names.length} file(s) of deal ${targetDeal.id}: ${names.join(', ')}`);
    await this.noteInDeal(
      targetDeal.id,
      `Автоматика удалила файлы сделки: триггер «${ACTION_NAMES[TriggerTypes.DELETE_FILES]}»${stageName ? ` этапа «${stageName}»` : ''}`,
      { removed_files: removed },
    );
    const list = names.slice(0, 20).join(', ') + (names.length > 20 ? ` и ещё ${names.length - 20}` : '');
    return done(`удалено файлов: ${names.length} (${list})`);
  }

  /**
   * A note of the automation in the deal's history: a comment without an author (nobody can edit or
   * delete it), e.g. which files a trigger deleted or why it could not act. Never throws: the run is
   * recorded anyway.
   */
  async noteInDeal(dealId: number, text: string, extra: Record<string, any> = {}): Promise<void> {
    try {
      await this.dataSource.getRepository(Event).save(
        EventBuilder.fromType(EventTypes.NEW_COMMENT)
          .linkToDeal({ id: dealId } as Deal)
          .addAfterState(EventWrapper.fromEntity({ comment: text.slice(0, 2000), files: [], automatic: true, ...extra })),
      );
    } catch (error) {
      this.logger.warn(`a note of the automation in deal ${dealId} failed: ${(error as Error).message}`);
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
  ): Promise<TriggerOutcome> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['agent']);
    if (!targetDeal) return skipped(NOT_FITTING);

    const agent = await this.helperService.getById(User, data.agent_id);
    if (targetDeal.agent?.id === agent.id) return skipped(`ответственный уже ${agent.username}`);
    const old = targetDeal.agent?.id;
    targetDeal.agent = agent;
    await this.dealRepository.save(targetDeal);
    this.emitFieldChanges(targetDeal, originatedBy ?? agent, [new Field('agent_id', String(agent.id), old ? String(old) : null)]);
    return done(`ответственный: ${agent.username}`);
  }

  private async handelChangeField(
    deal: Deal,
    data: ChangeFieldContents,
    filters: DealFilter[],
    originatedBy: User,
  ): Promise<TriggerOutcome> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['deal_fillers', 'deal_fillers.filler', 'agent']);
    if (!targetDeal) return skipped(NOT_FITTING);

    const changes: Field[] = [];
    const missing: string[] = [];
    const fillerRepository = this.dataSource.getRepository(Filler);
    const dealFillerRepository = this.dataSource.getRepository(DealFiller);

    for (const fieldData of data.fields ?? []) {
      const value = fieldData.value === null || fieldData.value === undefined ? '' : String(fieldData.value);
      if (fieldData.is_filler) {
        // by id when known: a renamed custom field keeps its triggers
        const byId = fieldData.filler_id ? Number(fieldData.filler_id) : null;
        const existing = (targetDeal.deal_fillers ?? []).find((df) =>
          byId ? df.filler?.id === byId : df.filler?.field === fieldData.field,
        );
        if (existing) {
          if (existing.value === value) continue;
          changes.push(new Field(existing.filler?.field ?? fieldData.field, value, existing.value));
          existing.value = value;
          await dealFillerRepository.save(existing);
        } else {
          const filler = byId
            ? await fillerRepository.findOne({ where: { id: byId, target: 'deal' } })
            : await fillerRepository.findOne({ where: { target: 'deal', field: fieldData.field } });
          if (!filler) {
            missing.push(fieldData.field);
            continue;
          }
          const dealFiller = new DealFiller();
          dealFiller.deal = targetDeal;
          dealFiller.filler = filler;
          dealFiller.value = value;
          await dealFillerRepository.save(dealFiller);
          // Deal.deal_fillers cascades: a saved deal whose array lacks the new row would orphan it
          targetDeal.deal_fillers = [...(targetDeal.deal_fillers ?? []), dealFiller];
          changes.push(new Field(filler.field, value, null));
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

    if (missing.length && changes.length === 0) {
      // the field was deleted: a failed run says so instead of a silent «done»
      throw new Error(`поля сделки больше нет: ${missing.join(', ')}`);
    }
    if (changes.length === 0) return skipped('поля уже имеют эти значения');
    await this.dealRepository.save(targetDeal);
    this.emitFieldChanges(targetDeal, originatedBy ?? targetDeal.agent, changes);
    const names = changes.map((c) =>
      c.name === 'agent_id' ? 'ответственный' : c.name === 'budget' ? 'бюджет' : c.name === 'label' ? 'название' : c.name,
    );
    return done(`изменено: ${names.join(', ')}` + (missing.length ? `; поля больше нет: ${missing.join(', ')}` : ''));
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
  ): Promise<TriggerOutcome> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['tasks', 'tasks.type', 'tasks.agent', 'agent']);
    if (!targetDeal) return skipped(NOT_FITTING);
    if (!targetDeal.tasks?.length) return skipped('в сделке нет открытых задач по условию');

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
    if (updatedTasks.length === 0) return skipped('в сделке нет открытых задач по условию');
    await this.taskRepository.save(updatedTasks);

    for (const task of updatedTasks) {
      const eventData: TaskEventDto = {
        task,
        deal: targetDeal,
        originated_by: originatedBy ?? targetDeal.agent ?? task.agent,
      };
      this.eventEmitter.emit(EventTypes.NEW_TASK_STATUS.toString(), eventData);
    }
    return done(`закрыто задач: ${updatedTasks.length}`);
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

  private async handleSendEmail(deal: Deal, data: SendEmailContents, filters: DealFilter[]): Promise<TriggerOutcome> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['created_by', 'agent', 'ctr_agents']);
    if (!targetDeal) return skipped(NOT_FITTING);

    const template = await this.helperService.getById(EmailTemplate, data.template_id);

    // a chosen user, else every contact of the deal with an email
    const recipients = data.send_to_user_id
      ? [(await this.helperService.getById(User, data.send_to_user_id)).email]
      : (targetDeal.ctr_agents ?? []).map((c) => c.email);
    const to = recipients.filter((email) => !!email && /@/.test(email));
    if (to.length === 0) {
      throw new Error(data.send_to_user_id ? 'у получателя нет адреса почты' : 'у контактов сделки нет адреса почты');
    }

    const sendEmailDto = new SendEmailDto();
    sendEmailDto.body = template.template_body;
    sendEmailDto.subject = template.subject ?? template.name ?? '';
    sendEmailDto.to = to;
    // in the history of this deal even when it is in a closed stage (the letter of a won deal)
    sendEmailDto.deal_id = targetDeal.id;

    const originatedBy =
      data.from === TaskResponsibleEnum.CREATOR
        ? targetDeal.created_by ?? targetDeal.agent
        : targetDeal.agent ?? targetDeal.created_by;

    // the history of deals gets this letter (NEW_EMAIL) while the trigger runs:
    // TriggerService ignores it, a trigger never fires on what a trigger did.
    // An automatic letter says so (RFC 3834, Exchange): the client's answering machine does not
    // reply to it, so "при письме" cannot ping-pong with it
    await this.emailService.sendEmail(sendEmailDto, originatedBy, [], {
      signature: true,
      headers: AUTOMATIC_LETTER_HEADERS,
    });
    return done(`письмо «${sendEmailDto.subject}»: ${to.join(', ')}`);
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
  ): Promise<TriggerOutcome> {
    if (depth >= MAX_CREATE_DEAL_DEPTH) {
      this.logger.warn(`create deal trigger skipped for deal ${deal.id}: a copy of a copy`);
      return skipped('сделка сама создана триггером: копия копии не создаётся');
    }
    const targetDeal = await this.getTargetDeal(deal, filters, ['agent', 'company', 'ctr_agents', 'created_by']);
    if (!targetDeal) return skipped(NOT_FITTING);

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
    return done(`создана сделка №${saved.display_id ?? saved.id} «${saved.label}» в этапе «${stage.name}»`);
  }

  /** Minutes from `lastStageChangeDate` to `inputDate` (kept for the old callers). */
  differenceInMinutes(inputDate: Date, lastStageChangeDate: Date): number {
    return (inputDate.getTime() - lastStageChangeDate.getTime()) / 60000;
  }
}
