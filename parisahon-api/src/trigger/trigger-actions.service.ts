import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import { Trigger, TriggerTypes } from './trigger.entity';
import { DataSource, Repository } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { TaskEventDto } from '../events/dto/task.event.dto';
import { Event, EventTypes, FieldsOf } from '../events/event.entity';
import { EventBuilder } from '../events/event.builder';
import { EventWrapper } from '../events/event.wrapper';
import { RoleEnum, User } from '../user/user.entity';
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
  MoveStageContents,
  NotifyContents,
  NotifyWhomEnum,
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
import { isClosingStage } from '../deal_stage/stage-kind';
import { DealStageEventDto } from '../events/dto/deal.stage.event.dto';
import { TRIGGER_NOTIFY, TriggerNotification } from './trigger-events';

// a "create deal" trigger may start a chain: a copy never creates further copies
const MAX_CREATE_DEAL_DEPTH = 1;
// «перевести в этап» may start a chain too (S1 -> S2 -> S3): never longer than this (no ping-pong)
const MAX_MOVE_DEPTH = 3;
const DAY_MINUTES = 24 * 60;
// the number columns of a deal a condition compares as numbers (budget is numeric: «777.00» as text)
const NUMERIC_COLUMNS = ['budget'];
const NUMBER = /^\s*-?\d+([.,]\d+)?\s*$/;
// a task of a trigger is never due at once («в момент события» was overdue as soon as it appeared)
const MIN_TASK_MINUTES = Math.max(5, Number(process.env.TRIGGER_TASK_MIN_MINUTES || 30));
// the channel of the first client event of a deal (condition «источник сделки»)
const SOURCE_BY_EVENT: Record<string, string> = {
  [EventTypes.NEW_TELEGRAM_MESSAGE]: 'telegram',
  [EventTypes.NEW_WHATSAPP_MESSAGE]: 'whatsapp',
  [EventTypes.NEW_EMAIL]: 'email',
  [EventTypes.NEW_CALL_RECORDING]: 'call',
};
export const SOURCE_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  email: 'почта',
  call: 'звонок',
  manual: 'создана вручную',
};
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
  // «перевести в этап» moved the deal: the other triggers of the old stage are not for it any more
  moved?: boolean;
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
  [TriggerTypes.MOVE_STAGE]: 'Перевести в этап',
  [TriggerTypes.NOTIFY]: 'Уведомить',
};

/**
 * How the deal whose triggers run got into its stage: by a person or a channel ({0, 0}), by
 * «Перевести в этап» (`moves` in a row) or as a copy made by «Создать сделку» (`copies`). A copy never
 * makes another copy, a chain of moves is cut at MAX_MOVE_DEPTH; a deal moved by a trigger into a stage
 * with «Создать сделку» still gets its copy (one counter used to stop both).
 */
export interface TriggerChain {
  moves: number;
  copies: number;
}

export const NO_CHAIN: TriggerChain = Object.freeze({ moves: 0, copies: 0 });

/**
 * A "create deal" trigger made `deal` in `stage`, or «перевести в этап» moved it there: the caller
 * gives it the triggers of that stage (TriggerService.onDealEnteredStage) one step further (`chain`).
 */
export type OnDealCreated = (
  originatedBy: User,
  deal: Deal,
  stage: DealStage,
  chain: TriggerChain,
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
    chain: TriggerChain,
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
        return this.handleChangeAgent(deal, { ...(trigger.data ?? {}), trigger_id: trigger.id }, filters, originatedBy);
      case TriggerTypes.SEND_EMAIL:
        return this.handleSendEmail(deal, trigger.data, filters);
      case TriggerTypes.CREATE_DEAL:
        return this.handleCreateDeal(deal, trigger.data, filters, originatedBy, chain ?? NO_CHAIN, onDealCreated, trigger.deal_stage?.name);
      case TriggerTypes.MOVE_STAGE:
        return this.handleMoveStage(deal, trigger.data, filters, originatedBy, chain ?? NO_CHAIN, onDealCreated);
      case TriggerTypes.NOTIFY:
        return this.handleNotify(deal, trigger.data, filters, originatedBy);
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

  /**
   * «уже есть открытая задача …» when the deal has an open task with this text, of any type and by
   * anybody (this trigger before, another trigger, the manager): five messages of the client are one
   * task «ответить», not five.
   */
  private async openSameTask(dealId: number, data: CreateTaskContents): Promise<string | null> {
    const label = TriggerActionsService.taskLabel(data);
    const rows = await this.dataSource.query(
      `SELECT id FROM task WHERE deal_id = $1 AND closed_at IS NULL AND label = $2 LIMIT 1`,
      [dealId, label],
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
      const params: Record<string, unknown> = { [`value${n}`]: value };
      if (filter.is_filler) {
        // by id: a renamed custom field keeps its triggers (by name for a trigger saved before the ids)
        const which = filter.filler_id
          ? `df${n}.filler_id = :filler${n}`
          : `df${n}.filler_id IN (SELECT fl.id FROM filler fl WHERE fl.target = 'deal' AND fl.field = :field${n})`;
        if (filter.filler_id) params[`filler${n}`] = Number(filter.filler_id);
        else params[`field${n}`] = filter.field;
        if (filter.op === 'ne') {
          // «не равно» also holds for a deal where the field is not filled in at all
          qb = qb.andWhere(
            `NOT EXISTS (SELECT 1 FROM deal_filler df${n} WHERE df${n}.deal_id = t0.id AND ${which} AND df${n}.value = :value${n})`,
            params,
          );
        } else {
          const test = TriggerActionsService.compareSql(`df${n}.value`, filter.op, `value${n}`);
          qb = qb.andWhere(`EXISTS (SELECT 1 FROM deal_filler df${n} WHERE df${n}.deal_id = t0.id AND ${which} AND ${test})`, params);
        }
      } else if (filter.field === 'source') {
        // the channel the deal came from: its first client event (a message, a letter, a call), else made by hand
        const first = `(SELECT e.type FROM event e WHERE e.deal_id = t0.id AND e.type IN (${Object.keys(SOURCE_BY_EVENT).join(', ')}) ORDER BY e.created_at, e.id LIMIT 1)`;
        const source = `(CASE ${Object.entries(SOURCE_BY_EVENT).map(([type, name]) => `WHEN ${first} = ${type} THEN '${name}'`).join(' ')} ELSE 'manual' END)`;
        qb = qb.andWhere(filter.op === 'ne' ? `${source} <> :value${n}` : `${source} = :value${n}`, params);
      } else {
        if (!/^[a-z_][a-z0-9_]*$/.test(filter.field)) {
          throw new BadRequestException(`Неизвестное поле в условии триггера: ${filter.field}`);
        }
        if (NUMERIC_COLUMNS.includes(filter.field) && (!filter.op || filter.op === 'eq' || filter.op === 'ne') && NUMBER.test(value)) {
          // «бюджет = 777» as numbers: the column is numeric(18,2) and reads «777.00» as text
          params[`value${n}`] = value.replace(',', '.').trim();
          const number = `CAST(t0.${filter.field} AS NUMERIC)`;
          qb = qb.andWhere(
            filter.op === 'ne' ? `(${number} IS NULL OR ${number} <> CAST(:value${n} AS NUMERIC))` : `${number} = CAST(:value${n} AS NUMERIC)`,
            params,
          );
          continue;
        }
        qb = qb.andWhere(TriggerActionsService.compareSql(`t0.${filter.field}`, filter.op, `value${n}`), params);
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

  /**
   * SQL of one condition: `column` against the parameter `param` by `op` — равно (as text), не равно,
   * больше / меньше (as numbers: a value that is not a number never matches), содержит (any case).
   */
  static compareSql(column: string, op: string | undefined, param: string): string {
    const text = `CAST(${column} AS TEXT)`;
    const number = `(CASE WHEN ${text} ~ '^\\s*-?[0-9]+([.][0-9]+)?\\s*$' THEN CAST(${text} AS NUMERIC) END)`;
    switch (op) {
      case 'ne':
        return `COALESCE(${text}, '') <> :${param}`;
      case 'gt':
        return `${number} > CAST(:${param} AS NUMERIC)`;
      case 'lt':
        return `${number} < CAST(:${param} AS NUMERIC)`;
      case 'contains':
        return `POSITION(LOWER(:${param}) IN LOWER(COALESCE(${text}, ''))) > 0`;
      default:
        return `${text} = :${param}`;
    }
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
   *  - other minutes: exactly that much later; «сразу» (0) is TRIGGER_TASK_MIN_MINUTES (30) to react,
   *    not a task that is overdue as soon as it appears.
   */
  static taskDeadline(data: CreateTaskContents, now = new Date(), schedule = new WorkSchedule()): Date {
    const given = Math.max(0, Number(data?.end_time_in_minutes ?? 0) || 0);
    const minutes = given > 0 ? given : MIN_TASK_MINUTES;
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
      // a dismissed employee is an error in words, not "User with id 5 does not exist!"
      return this.employee(data.exact_user_id, 'исполнитель задачи');
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
    data: ChangeAgentContents & { trigger_id?: number },
    filters: DealFilter[],
    originatedBy: User,
  ): Promise<TriggerOutcome> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['agent']);
    if (!targetDeal) return skipped(NOT_FITTING);

    const rotation = (data.rotate_user_ids ?? []).map(Number).filter((id) => id > 0);
    const agent = rotation.length
      ? await this.nextInTurn(Number(data.trigger_id ?? 0), rotation)
      : await this.employee(data.agent_id, 'новый ответственный');
    if (targetDeal.agent?.id === agent.id) return skipped(`ответственный уже ${agent.username}`);
    const old = targetDeal.agent?.id ?? null;
    targetDeal.agent = agent;
    await this.dealRepository.save(targetDeal);
    this.emitFieldChanges(targetDeal, originatedBy ?? agent, [new Field('agent_id', String(agent.id), old ? String(old) : null)]);
    const moved = data.transfer_tasks === false ? 0 : await this.transferOpenTasks(targetDeal.id, old, agent.id);
    return done(`ответственный: ${agent.username}${rotation.length ? ' (по очереди)' : ''}${moved ? `; передано открытых задач: ${moved}` : ''}`);
  }

  /**
   * An employee a trigger names, at the moment it runs: a dismissed one or a contact of a client is
   * an error in words («сотрудник … уволен»), not "User with id 5 does not exist!".
   */
  private async employee(id: number, what: string): Promise<User> {
    const [row] = await this.dataSource.query(`SELECT id, username, role, deleted_at FROM "user" WHERE id = $1`, [Number(id)]);
    if (!row) throw new Error(`${what} (сотрудник №${id}) удалён — исправьте триггер`);
    if (row.deleted_at) throw new Error(`${what} «${row.username}» уволен (удалён из CRM) — выберите другого сотрудника в триггере`);
    if (row.role === RoleEnum.CTR_AGENT) throw new Error(`«${row.username}» — контакт клиента, а не сотрудник: ответственным может быть только сотрудник`);
    return this.helperService.getById(User, Number(id));
  }

  /**
   * «По очереди»: the next employee of the list after the one who got the previous deal of this
   * trigger (the last one is kept in trigger.data.rotation_last, under a lock of the trigger's row, so
   * that two deals at once go to two people). Dismissed employees and contacts are passed over.
   */
  private async nextInTurn(triggerId: number, ids: number[]): Promise<User> {
    const people: { id: number }[] = await this.dataSource.query(
      `SELECT id FROM "user" WHERE id = ANY($1) AND deleted_at IS NULL AND role <> $2`,
      [ids, RoleEnum.CTR_AGENT],
    );
    const usable = ids.filter((id) => people.some((p) => Number(p.id) === id));
    if (usable.length === 0) throw new Error('в очереди триггера не осталось сотрудников (все уволены) — исправьте триггер');
    if (!triggerId) return this.helperService.getById(User, usable[0]);
    const chosen = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(`SELECT data->>'rotation_last' AS last FROM "trigger" WHERE id = $1 FOR UPDATE`, [triggerId]);
      const last = Number(row?.last ?? 0);
      const at = ids.indexOf(last);
      // the next one in the order of the list after the last, among the usable
      const order = at < 0 ? ids : [...ids.slice(at + 1), ...ids.slice(0, at + 1)];
      const next = order.find((id) => usable.includes(id)) ?? usable[0];
      await manager.query(`UPDATE "trigger" SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{rotation_last}', to_jsonb($2::int)) WHERE id = $1`, [triggerId, next]);
      return next;
    });
    return this.helperService.getById(User, chosen);
  }

  /**
   * The open tasks of the deal that the previous responsible had go to the new one; how many. Through
   * TypeORM, so that the task pages of both refresh themselves (gateway/live-updates.subscriber.ts).
   */
  private async transferOpenTasks(dealId: number, from: number | null, to: number): Promise<number> {
    if (!from || from === to) return 0;
    const result = await this.taskRepository
      .createQueryBuilder()
      .update(Task)
      .set({ agent: { id: to } as User })
      .where('deal_id = :deal AND agent_id = :from AND closed_at IS NULL', { deal: dealId, from })
      .execute();
    return Number(result?.affected ?? 0);
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
    let previousAgent: number | null = null;
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
          const agent = await this.employee(Number(value), 'новый ответственный');
          if (targetDeal.agent?.id === agent.id) continue;
          changes.push(new Field('agent_id', String(agent.id), targetDeal.agent ? String(targetDeal.agent.id) : null));
          previousAgent = targetDeal.agent?.id ?? null;
          targetDeal.agent = agent;
          break;
        }
        case 'budget': {
          const budget = Number(String(value).replace(/\s+/g, '').replace(',', '.'));
          if (!value.trim() || !Number.isFinite(budget)) throw new Error(`бюджет «${value}» — не число: исправьте значение в триггере`);
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
    // a new responsible gets the open tasks of the deal too (as «Сменить ответственного» does)
    const moved = previousAgent ? await this.transferOpenTasks(targetDeal.id, previousAgent, targetDeal.agent.id) : 0;
    const names = changes.map((c) =>
      c.name === 'agent_id' ? 'ответственный' : c.name === 'budget' ? 'бюджет' : c.name === 'label' ? 'название' : c.name,
    );
    return done(
      `изменено: ${names.join(', ')}` +
        (missing.length ? `; поля больше нет: ${missing.join(', ')}` : '') +
        (moved ? `; передано открытых задач: ${moved}` : ''),
    );
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
      // no type (0 / not set): tasks of any type
      if (Number(data.type_id) > 0 && Number(data.type_id) !== task.type?.id) continue;
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
    const targetDeal = await this.getTargetDeal(deal, filters, ['created_by', 'agent', 'ctr_agents', 'company', 'stage']);
    if (!targetDeal) return skipped(NOT_FITTING);

    const template = await this.dataSource.getRepository(EmailTemplate).findOne({ where: { id: Number(data.template_id) } });
    if (!template) throw new Error(`шаблон письма (№${data.template_id}) удалён — выберите шаблон в триггере`);

    // a chosen user, else every contact of the deal with an email
    const recipients = data.send_to_user_id
      ? [(await this.helperService.getById(User, data.send_to_user_id)).email]
      : (targetDeal.ctr_agents ?? []).map((c) => c.email);
    const to = recipients.filter((email) => !!email && /@/.test(email));
    if (to.length === 0) {
      throw new Error(data.send_to_user_id ? 'у получателя нет адреса почты' : 'у контактов сделки нет адреса почты');
    }

    const originatedBy =
      data.from === TaskResponsibleEnum.CREATOR
        ? targetDeal.created_by ?? targetDeal.agent
        : targetDeal.agent ?? targetDeal.created_by;

    const sendEmailDto = new SendEmailDto();
    // {{клиент}}, {{сделка}}, {{сумма}}, {{менеджер}} ... of this deal (TriggerActionsService.fillPlaceholders)
    sendEmailDto.body = TriggerActionsService.fillPlaceholders(template.template_body ?? '', targetDeal, true);
    sendEmailDto.subject = TriggerActionsService.fillPlaceholders(template.subject ?? template.name ?? '', targetDeal, false);
    sendEmailDto.to = to;
    // in the history of this deal only, even when it is in a closed stage (the letter of a won deal)
    sendEmailDto.deal_id = targetDeal.id;
    // from the sender's own mailbox when it is connected and checked: the client answers the manager,
    // not the shared box; otherwise (or when the trigger says so) from the shared mailbox
    const mailbox = data.shared_mailbox ? null : await this.ownMailbox(originatedBy?.id);
    if (mailbox) sendEmailDto.transporter_id = mailbox.id;
    // the КП / the invoice uploaded to the deal goes with the letter (attach_extensions)
    const files = await this.dealAttachments(targetDeal.id, data.attach_extensions ?? []);

    // the history of deals gets this letter (NEW_EMAIL) while the trigger runs:
    // TriggerService ignores it, a trigger never fires on what a trigger did.
    // An automatic letter says so (RFC 3834, Exchange): the client's answering machine does not
    // reply to it, so "при письме" cannot ping-pong with it
    await this.emailService.sendEmail(sendEmailDto, originatedBy, files, {
      signature: true,
      headers: AUTOMATIC_LETTER_HEADERS,
    });
    const attached = files.length ? `, вложения: ${files.map((f) => f.originalname).join(', ')}` : '';
    return done(`письмо «${sendEmailDto.subject}»${mailbox ? ` с ящика ${mailbox.email}` : ''}: ${to.join(', ')}${attached}`);
  }

  /** ".pdf" for "pdf", "PDF", ".Pdf"; garbage is dropped (the API checks the trigger on save, normalizedExtensions). */
  static normalizedExtensions(list: unknown[]): string[] {
    const result: string[] = [];
    for (const item of list ?? []) {
      const ext = String(item ?? '').trim().toLowerCase().replace(/^\.*/, '.');
      if (/^\.[a-z0-9]{1,16}$/.test(ext) && !result.includes(ext)) result.push(ext);
    }
    return result;
  }

  /**
   * The deal's files of the given extensions for a letter of «Отправить письмо» (the КП, the invoice the
   * manager uploaded to the deal): the newest first, at most 5 and EMAIL_MAX_ATTACHMENTS_MB (20) together.
   * Asked for and none in the deal: an error — the letter does not go without its file, and the run, the
   * deal's history and the admins say why.
   */
  private async dealAttachments(dealId: number, extensions: string[]): Promise<Express.Multer.File[]> {
    const wanted = TriggerActionsService.normalizedExtensions(extensions);
    if (wanted.length === 0) return [];
    const rows: { name: string; path: string }[] = await this.dataSource.query(
      `SELECT f.name, f.path FROM file f JOIN deal_file df ON df."fileId" = f.id
        WHERE df."dealId" = $1 AND LOWER(COALESCE(f.extension, '')) = ANY($2)
        ORDER BY f.created_at DESC, f.id DESC LIMIT 20`,
      [dealId, wanted],
    );
    const limit = (Number(process.env.EMAIL_MAX_ATTACHMENTS_MB ?? 20) || 20) * 1024 * 1024;
    const files: Express.Multer.File[] = [];
    let total = 0;
    for (const row of rows) {
      if (files.length >= 5) break;
      let buffer: Buffer;
      try {
        buffer = await readFile(join(FileService.UPLOADS_DIR, basename(String(row.path))));
      } catch {
        continue; // the row is there, the file is gone from the disk
      }
      if (total + buffer.length > limit) continue;
      total += buffer.length;
      files.push({
        fieldname: 'files',
        originalname: row.name,
        encoding: '7bit',
        mimetype: 'application/octet-stream',
        size: buffer.length,
        buffer,
      } as Express.Multer.File);
    }
    if (files.length === 0) {
      throw new Error(`в сделке нет файла ${wanted.join(', ')} для письма — загрузите его в сделку; письмо не отправлено`);
    }
    return files;
  }

  /** The sender's own mailbox that the mail server accepted (verified_at), if any. */
  private async ownMailbox(userId?: number): Promise<{ id: number; email: string } | null> {
    if (!userId) return null;
    const [row] = await this.dataSource.query(
      `SELECT id, email FROM email_transporter WHERE user_id = $1 AND verified_at IS NOT NULL ORDER BY id LIMIT 1`,
      [userId],
    );
    return row ? { id: Number(row.id), email: row.email } : null;
  }

  /**
   * The placeholders of a letter or a message of a trigger, filled in with the deal (`html`: the values
   * are escaped for an HTML body). Russian or Latin names, any case and spaces: {{клиент}} / {{client}},
   * {{компания}}, {{сделка}}, {{номер}}, {{сумма}}, {{менеджер}}, {{этап}}, {{ссылка}}. An unknown one stays.
   */
  static fillPlaceholders(text: string, deal: Deal, html: boolean): string {
    const contact = (deal.ctr_agents ?? [])[0];
    const budget = deal.budget === null || deal.budget === undefined || String(deal.budget) === '' ? '' : Number(deal.budget).toLocaleString('ru-RU');
    const base = (process.env.CRM_PUBLIC_URL || '').replace(/\/+$/, '');
    const values: Record<string, string> = {
      'клиент': contact?.username ?? '',
      'контакт': contact?.username ?? '',
      client: contact?.username ?? '',
      contact: contact?.username ?? '',
      'компания': deal.company?.name ?? '',
      company: deal.company?.name ?? '',
      'сделка': deal.label ?? '',
      deal: deal.label ?? '',
      'номер': deal.display_id ? String(deal.display_id) : '',
      'номер сделки': deal.display_id ? String(deal.display_id) : '',
      number: deal.display_id ? String(deal.display_id) : '',
      'сумма': budget,
      'бюджет': budget,
      budget,
      'менеджер': deal.agent?.username ?? '',
      'ответственный': deal.agent?.username ?? '',
      manager: deal.agent?.username ?? '',
      'этап': deal.stage?.name ?? '',
      stage: deal.stage?.name ?? '',
      'ссылка': base ? `${base}/deals/${deal.id}` : '',
      link: base ? `${base}/deals/${deal.id}` : '',
    };
    const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return String(text ?? '').replace(/\{\{\s*([^{}]{1,40}?)\s*\}\}/g, (all, name: string) => {
      const key = name.toLowerCase().replace(/\s+/g, ' ');
      if (!(key in values)) return all;
      return html ? escape(values[key]) : values[key];
    });
  }

  /**
   * "Создать сделку": a copy of the deal (client, company, responsible) in another stage.
   * The copy gets the triggers of its stage (`onDealCreated`), but never another copy (chain.copies).
   */
  private async handleCreateDeal(
    deal: Deal,
    data: CreateDealContents,
    filters: DealFilter[],
    originatedBy: User,
    chain: TriggerChain,
    onDealCreated: OnDealCreated,
    stageName?: string,
  ): Promise<TriggerOutcome> {
    if (chain.copies >= MAX_CREATE_DEAL_DEPTH) {
      this.logger.warn(`create deal trigger skipped for deal ${deal.id}: a copy of a copy`);
      return skipped('сделка сама создана триггером: копия копии не создаётся');
    }
    const targetDeal = await this.getTargetDeal(deal, filters, ['agent', 'company', 'ctr_agents', 'created_by']);
    if (!targetDeal) return skipped(NOT_FITTING);

    const stage = await this.dataSource.getRepository(DealStage).findOne({ where: { id: Number(data.stage_id) } });
    if (!stage) throw new Error(`этап (№${data.stage_id}) для новой сделки удалён — выберите этап в триггере`);
    const newDeal = new Deal();
    newDeal.label = (data.label || '').trim() || `${targetDeal.label} (копия)`;
    newDeal.budget = targetDeal.budget;
    newDeal.agent = targetDeal.agent;
    newDeal.company = targetDeal.company;
    newDeal.ctr_agents = targetDeal.ctr_agents ?? [];
    newDeal.created_by = originatedBy ?? targetDeal.created_by ?? targetDeal.agent;
    newDeal.stage = stage;
    newDeal.last_stage_change = new Date();
    // a copy made right in «успешно реализовано» / «закрыто и не реализовано» is closed (DEAL-2)
    if (isClosingStage(stage)) newDeal.closed_at = new Date();
    // the next sequential number is given while saving
    const saved = await this.helperService.saveNewDeal(newDeal);

    const record = new DealStageRecord();
    record.deal = saved;
    record.stage = stage;
    await this.dataSource.getRepository(DealStageRecord).save(record);

    // the order goes on in production with its article, parameters and items: the custom fields and
    // the products of the deal come with it (unless the trigger says no)
    const copied: string[] = [];
    if (data.copy_fields !== false) {
      const rows = await this.dataSource.query(
        `INSERT INTO deal_filler (deal_id, filler_id, value)
         SELECT $2, df.filler_id, df.value FROM deal_filler df JOIN filler f ON f.id = df.filler_id
          WHERE df.deal_id = $1 AND f.target = 'deal' RETURNING id`,
        [targetDeal.id, saved.id],
      );
      if (rows?.length) copied.push(`доп. поля: ${rows.length}`);
    }
    if (data.copy_products !== false) {
      const rows = await this.dataSource.query(
        `INSERT INTO deal_product (deal_id, product_id, quantity, price)
         SELECT $2, product_id, quantity, price FROM deal_product WHERE deal_id = $1 ORDER BY id RETURNING id`,
        [targetDeal.id, saved.id],
      );
      if (rows?.length) copied.push(`товары: ${rows.length}`);
    }
    // both deals say where the other one is
    const number = (d: Deal) => `№${d.display_id ?? d.id}`;
    await this.noteInDeal(saved.id, `Сделка создана автоматикой из сделки ${number(targetDeal)} «${targetDeal.label}»${stageName ? ` (триггер этапа «${stageName}»)` : ''}`, {
      source_deal_id: targetDeal.id,
    });
    await this.noteInDeal(targetDeal.id, `Автоматика создала сделку ${number(saved)} «${saved.label}» в этапе «${stage.name}»`, {
      copy_deal_id: saved.id,
    });

    this.eventEmitter.emit(EventTypes.NEW_DEAL.toString(), { deal: saved });
    await onDealCreated(newDeal.created_by, saved, stage, { moves: chain.moves, copies: chain.copies + 1 });
    return done(`создана сделка ${number(saved)} «${saved.label}» в этапе «${stage.name}»${copied.length ? ` (${copied.join(', ')})` : ''}`);
  }

  /**
   * «Перевести в этап»: the deal goes to another stage the way a manager moves it (closed in a closing
   * stage, open again elsewhere, the stage history, the NEW_DEAL_STAGE event) and gets the triggers of
   * that stage one step further. A chain of moves is cut at MAX_MOVE_DEPTH (no ping-pong of two stages).
   */
  private async handleMoveStage(
    deal: Deal,
    data: MoveStageContents,
    filters: DealFilter[],
    originatedBy: User,
    chain: TriggerChain,
    onDealEntered: OnDealCreated,
  ): Promise<TriggerOutcome> {
    if (chain.moves >= MAX_MOVE_DEPTH) {
      this.logger.warn(`move stage trigger skipped for deal ${deal.id}: a chain of ${chain.moves} moves`);
      return skipped('сделку уже перевели другие триггеры: цепочка переходов прервана (защита от зацикливания)');
    }
    const targetDeal = await this.getTargetDeal(deal, filters, ['stage', 'agent', 'created_by']);
    if (!targetDeal) return skipped(NOT_FITTING);
    const stage = await this.dataSource.getRepository(DealStage).findOne({ where: { id: Number(data.stage_id) } });
    if (!stage) throw new Error(`этап (№${data.stage_id}), куда триггер переводит сделку, удалён — выберите этап в триггере`);
    if (targetDeal.stage?.id === stage.id) return skipped(`сделка уже в этапе «${stage.name}»`);

    const oldStage = targetDeal.stage ?? null;
    const now = new Date();
    const closedAt = isClosingStage(stage) ? now : null;
    // through the entity (as DealService moves a deal): the kanban and the deal page refresh themselves
    // (gateway/live-updates.subscriber.ts) and the journal sees the change; only stage, agent and author
    // are loaded, so nothing else of the deal is written
    targetDeal.stage = stage;
    targetDeal.last_stage_change = now;
    targetDeal.closed_at = closedAt;
    await this.dealRepository.save(targetDeal);
    // the stage history: how long the deal stayed in the previous stage, then the new record
    await this.dataSource.query(
      `UPDATE deal_stage_record SET moved_after_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) / 60))
        WHERE id = (SELECT id FROM deal_stage_record WHERE deal_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1)`,
      [targetDeal.id],
    );
    const record = new DealStageRecord();
    record.deal = targetDeal;
    record.stage = stage;
    record.from_stage = oldStage;
    record.moved_by = null;
    await this.dataSource.getRepository(DealStageRecord).save(record);

    const eventData = new DealStageEventDto();
    eventData.deal = targetDeal;
    eventData.new_stage = stage;
    eventData.old_stage = oldStage;
    eventData.originated_by = originatedBy ?? targetDeal.agent;
    // the history gets this move after the one that brought the deal here: the request that moved it
    // announces its own move only when the triggers of that stage (this one) are done
    setImmediate(() => this.eventEmitter.emit(EventTypes.NEW_DEAL_STAGE.toString(), eventData));

    await onDealEntered(originatedBy ?? targetDeal.agent, targetDeal, stage, { moves: chain.moves + 1, copies: chain.copies });
    return { status: 'done', note: `сделка переведена в этап «${stage.name}»${oldStage ? ` из «${oldStage.name}»` : ''}`, moved: true };
  }

  /**
   * «Уведомить»: a message to the responsible, the managers (admins and managers) or a chosen employee
   * in the CRM bot (BotWaitingService, TRIGGER_NOTIFY); whoever the bot could not tell gets a task with
   * the text in the deal instead, so that nothing is lost.
   */
  private async handleNotify(deal: Deal, data: NotifyContents, filters: DealFilter[], originatedBy: User): Promise<TriggerOutcome> {
    const targetDeal = await this.getTargetDeal(deal, filters, ['agent', 'company', 'ctr_agents', 'stage', 'created_by']);
    if (!targetDeal) return skipped(NOT_FITTING);
    const ids = new Set<number>();
    if (data.user_id) {
      ids.add((await this.employee(Number(data.user_id), 'получатель уведомления')).id);
    } else {
      const to = data.to ?? NotifyWhomEnum.RESPONSIBLE;
      if (to !== NotifyWhomEnum.MANAGERS && targetDeal.agent?.id) ids.add(targetDeal.agent.id);
      if (to !== NotifyWhomEnum.RESPONSIBLE) {
        const bosses: { id: number }[] = await this.dataSource.query(
          `SELECT id FROM "user" WHERE role IN ($1, $2) AND deleted_at IS NULL`,
          [RoleEnum.ADMIN, RoleEnum.MANAGER],
        );
        bosses.forEach((b) => ids.add(Number(b.id)));
      }
    }
    // only those who work here: the responsible of an old deal may have been dismissed
    if (ids.size) {
      const active: { id: number }[] = await this.dataSource.query(
        `SELECT id FROM "user" WHERE id = ANY($1) AND deleted_at IS NULL AND role <> $2`,
        [[...ids], RoleEnum.CTR_AGENT],
      );
      const keep = new Set(active.map((u) => Number(u.id)));
      [...ids].forEach((id) => { if (!keep.has(id)) ids.delete(id); });
    }
    if (ids.size === 0) return skipped('некого уведомить: у сделки нет ответственного (или он уволен)');

    const text = TriggerActionsService.fillPlaceholders(data.text, targetDeal, false).trim();
    const base = (process.env.CRM_PUBLIC_URL || '').replace(/\/+$/, '');
    const message = `${text}\nСделка №${targetDeal.display_id ?? targetDeal.id} «${targetDeal.label}»${base ? `\n${base}/deals/${targetDeal.id}` : ''}`;
    const payload: TriggerNotification = { user_ids: [...ids], text: message, deal_id: targetDeal.id };
    let told = new Set<number>();
    try {
      const answers = await this.eventEmitter.emitAsync(TRIGGER_NOTIFY, payload);
      told = new Set((answers ?? []).flat().filter((id) => Number.isFinite(Number(id))).map(Number));
    } catch (error) {
      this.logger.warn(`notify trigger: the bot failed for deal ${targetDeal.id}: ${(error as Error).message}`);
    }
    const missed = [...ids].filter((id) => !told.has(id));
    for (const id of missed) {
      await this.createTaskFor(targetDeal, id, `Авто: ${text}`.slice(0, 255), originatedBy);
    }
    return done(`уведомление: в бот ${told.size}${missed.length ? `, задачей в CRM ${missed.length} (бот не подключён)` : ''}`);
  }

  /**
   * A task of the automation for one employee in the deal (due by the end of the working day); not a
   * second one while the same task of this employee is open (a notification of every unanswered message).
   */
  private async createTaskFor(deal: Deal, userId: number, label: string, originatedBy: User): Promise<void> {
    const open = await this.dataSource.query(
      `SELECT 1 FROM task WHERE deal_id = $1 AND agent_id = $2 AND closed_at IS NULL AND label = $3 LIMIT 1`,
      [deal.id, userId, label],
    );
    if (open.length) return;
    const agent = await this.helperService.getById(User, userId);
    const now = new Date();
    const task = new Task();
    task.agent = agent;
    task.created_by = originatedBy ?? deal.created_by ?? deal.agent ?? agent;
    task.deal = deal;
    task.company = deal.company ?? null;
    task.type = await defaultTaskType(this.taskRepository.manager);
    task.allDay = false;
    task.start_time = now;
    task.end_time = endOfWorkingDay(new WorkSchedule(), now, 30 * 60);
    task.label = label;
    const saved = await this.taskRepository.save(task);
    this.eventEmitter.emit(EventTypes.NEW_TASK.toString(), { task: saved, deal, originated_by: task.created_by } as TaskEventDto);
  }

  /** Minutes from `lastStageChangeDate` to `inputDate` (kept for the old callers). */
  differenceInMinutes(inputDate: Date, lastStageChangeDate: Date): number {
    return (inputDate.getTime() - lastStageChangeDate.getTime()) / 60000;
  }
}
