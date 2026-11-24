import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AsyncLocalStorage } from 'async_hooks';
import { Trigger, TriggerTypes } from './trigger.entity';
import { TriggerRun, TriggerRunStatus } from './trigger-run.entity';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { EventTypes } from '../events/event.entity';
import { RoleEnum, User } from '../user/user.entity';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { TaskType } from '../task_type/task_type.entity';
import { HelperService } from '../helper/helper.service';
import {
  ApplyTriggerWhenEnum,
  AssignTriggerDto,
  DealFilter,
} from './dto/assign.trigger.dto';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { LoggerService } from '../helper/logger.service';
import { EmailTemplate } from '../email/email.template.entity';
import { Email } from '../email/email.entity';
import { Filler } from '../filler/filler.entity';
import { EmailEventDto } from '../events/dto/email.event.dto';
import { CallRecordingEventDto } from '../events/dto/call.recording.event.dto';
import { ACTION_NAMES, NOT_FITTING, NO_CHAIN, SOURCE_NAMES, TriggerActionsService, TriggerChain, TriggerOutcome } from './trigger-actions.service';
import { TRIGGER_BROKEN, TRIGGER_RUN_FAILED, TriggerBrokenReport, TriggerBrokenSummary, TriggerRunFailure } from './trigger-events';
import { ANSWER_TYPES, CHAT_TYPES, WorkSchedule, answerSql, clientMessageSql } from '../analytics/control.service';
import { DEAL_SOURCES } from './dto/assign.trigger.dto';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { AuditJournal } from '../audit/audit-journal';

export type TriggerKind = 'immediate' | 'delayed' | 'recurring' | 'event';

export interface DealEventContext {
  outgoing?: boolean;
  // the author of the event (for an incoming message: the contact)
  from_user_id?: number;
  // the employee of the event: the manager of the chat or of the call. Not given: the author of an
  // outgoing event, else the responsible of the deal (TriggerService.staffOf)
  staff_user_id?: number;
  // one letter goes into every open deal of its sender: a "send email" trigger answers it once
  // (`once_key` = the letter, `fired` = the triggers that already answered it), not once per deal
  once_key?: string;
  fired?: Set<string>;
}

const EVENT_WHENS = [
  ApplyTriggerWhenEnum.EMAIL_RECEIVED,
  ApplyTriggerWhenEnum.TG_MESSAGE_RECEIVED,
  ApplyTriggerWhenEnum.WA_MESSAGE_RECEIVED,
  ApplyTriggerWhenEnum.CALL_RECORDED,
];
// "нет ответа N минут": not a message, a state over time (checked by the scheduler, runNoReply)
const WAITING_WHENS = [ApplyTriggerWhenEnum.NO_REPLY];
const RECURRING_WHENS = [
  ApplyTriggerWhenEnum.EVERY_DAY,
  ApplyTriggerWhenEnum.EVERY_WEEK,
  ApplyTriggerWhenEnum.EVERY_MONTH,
  ApplyTriggerWhenEnum.EVERY_YEAR,
];
// a run that waited longer than this (the API was down) is skipped, not executed late
const MISSED_AFTER_MINUTES = Math.max(1, Number(process.env.TRIGGER_MISSED_AFTER_MINUTES || 24 * 60));
const DEAL_COLUMNS_A_TRIGGER_MAY_CHANGE = ['label', 'budget', 'agent_id'];
// whatever goes wrong, one trigger acts for one deal at most this many times in 24 hours
const MAX_RUNS_PER_DEAL_DAY = Math.max(1, Number(process.env.TRIGGER_MAX_RUNS_PER_DEAL_DAY || 50));
const MAX_EMAILS_PER_DEAL_DAY = Math.max(1, Number(process.env.TRIGGER_MAX_EMAILS_PER_DEAL_DAY || 5));
// "при письме" ignores older letters: the first sync of a mailbox brings years of mail
const EMAIL_MAX_AGE_HOURS = Math.max(1, Number(process.env.TRIGGER_EMAIL_MAX_AGE_HOURS || 24));
// an answering machine's letter is not a client writing (and answering it would start a ping-pong)
const AUTO_REPLY_SUBJECT =
  /^\s*(auto(matic)?[\s_-]*(reply|response|antwort)|autoreply|out of (the )?office|автоответ|автоматический ответ|abwesenheit)/i;
// nor is a bounce of a mail server: it quotes the letter of a trigger, and answering it bounces again
const BOUNCE_SUBJECT =
  /^\s*(undeliver(ed|able)|delivery (status notification|failure|has failed)|mail delivery (failed|failure|subsystem)|returned mail|failure notice|недоставлен|не доставлено|сообщение не доставлено)/i;
const BOUNCE_SENDER = /^\s*(mailer-daemon|postmaster)@/i;
// a row taken longer ago than this was cut off by a restart of the API in the middle of the action
const RUNNING_STALE_MINUTES = 15;
// finished rows older than this are deleted (the last done run of a trigger and deal stays: "only once");
// skipped ones (a recurring trigger leaves one per deal and day for deals that do not fit) sooner
const KEEP_RUNS_DAYS = Math.max(7, Number(process.env.TRIGGER_RUNS_KEEP_DAYS || 90));
const KEEP_SKIPPED_DAYS = Math.max(1, Math.min(KEEP_RUNS_DAYS, Number(process.env.TRIGGER_SKIPPED_KEEP_DAYS || 30)));

const LEFT_STAGE = 'сделка ушла из этапа';
const SCHEDULE_CHANGED = 'расписание триггера изменено: этот запуск больше не нужен';
// one tick of the schedule at a time in the whole installation (two API processes during a deploy)
const TICK_LOCK = 7_401_202;
// a broken trigger (it names something deleted) is told to the admins at most once a day; the check
// runs every 10 minutes, so an employee dismissed or a template deleted is heard of soon
const BROKEN_TELL_EVERY_MS = 24 * 3_600_000;
const BROKEN_CHECK_EVERY_MS = 10 * 60_000;
const CUT_OFF = 'прерван: API перезапустился во время выполнения';

// what a trigger's setting names and is gone ("TaskType with id 5 does not exist!", HelperService.getById)
const GONE_NAMES: Record<string, string> = {
  TaskType: 'тип задачи',
  User: 'сотрудник',
  EmailTemplate: 'шаблон письма',
  DealStage: 'этап',
};

/** An error of a run in words for a manager or an admin (the run keeps the original text). */
export function humanError(message: string): string {
  const text = String(message ?? '').trim();
  const gone = /^(\w+) with id (\d+) does not exist/.exec(text);
  if (gone && GONE_NAMES[gone[1]]) {
    return `в настройке триггера указан ${GONE_NAMES[gone[1]]} (№${gone[2]}), которого больше нет — триггер нужно исправить`;
  }
  return text || 'неизвестная ошибка';
}

/** "a day", "3 hours", "30 minutes" in Russian, for the reasons of skipped runs. */
function minutesText(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'сутки' : `${minutes / 1440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${minutes} мин`;
}

function affected(result: any): number {
  return Array.isArray(result) ? Number(result[1] ?? 0) : 0;
}

/**
 * Triggers of the funnel stages.
 *
 * When they fire (`kindOf`):
 *  - immediate: right after the deal is created in / moved to the stage;
 *  - delayed: N minutes after that, or at an exact date and time;
 *  - recurring: every day / week / month / year while the deal stays in the stage;
 *  - event: when a Telegram or WhatsApp message, an email or a call of the deal arrives (`onDealEvent`),
 *    or when a client waits for an answer N working minutes («нет ответа», `runNoReply`, every tick).
 * The triggers of a stage run in their order (`position`, then id; the settings page sets it).
 * Delayed and recurring executions are rows of `trigger_run` (the schedule lives
 * in the database); TriggerScheduler executes the due rows, each taken by one UPDATE
 * (pending -> running), so two ticks never execute one row; one tick at a time in the whole
 * installation (an advisory lock), and every execution has a key (`run_key`: this entry into the
 * stage, this stay, this occurrence, this letter, this unanswered message) unique per trigger and
 * deal, so the same thing is never executed twice. Every execution is caught
 * and logged: a broken trigger is a failed run (a message to the admins in the bot,
 * TRIGGER_RUN_FAILED, and a note «Автоматика не сработала …» in the deal's history), never a
 * crash of the API.
 *
 * No loops, bounded repeats:
 *  - nothing a trigger's action produces (its letter, in any deal) fires event triggers (`acting`),
 *    and its letters say Auto-Submitted, so that the client's answering machine does not reply;
 *  - "при письме" ignores old letters (the first sync of a mailbox), spam, answering machines and bounces,
 *    and one letter that lands in several open deals is answered by a "send email" trigger once;
 *  - a trigger acts for a deal only once if so set (default for "create deal"), not again within
 *    its pause (`cooldown_minutes`, default a day for "send email"), and never more than
 *    TRIGGER_MAX_RUNS_PER_DEAL_DAY (50; letters TRIGGER_MAX_EMAILS_PER_DEAL_DAY, 5) times a day;
 *  - "create task" does not add the same task while it is still open in the deal.
 * The letter of a "send email" that fires on entering the stage or on an event is queued (a run due
 * at once) and sent right after the request: neither the kanban nor an incoming message waits for
 * the mail server.
 * What a trigger does to the deal is TriggerActionsService's.
 */
@Injectable()
export class TriggerService {
  private readonly logger = new Logger(TriggerService.name);
  /** Set while a trigger action runs: the events it causes are its own, event triggers ignore them. */
  private static readonly acting = new AsyncLocalStorage<{ trigger_id: number; deal_id: number }>();
  private lastCleanup = 0;
  // the first check for broken triggers comes 2 minutes after the start, then every 10 minutes
  private lastBrokenCheck = Date.now() - BROKEN_CHECK_EVERY_MS + 2 * 60_000;
  private brokenTold = new Map<number, number>();
  // a pass over the queue (letters due now) is already scheduled
  private queuedPass = false;

  constructor(
    @InjectRepository(Trigger)
    private triggerRepository: Repository<Trigger>,
    @InjectRepository(TriggerRun)
    private runRepository: Repository<TriggerRun>,
    @InjectRepository(Deal)
    private dealRepository: Repository<Deal>,
    private dataSource: DataSource,
    private helperService: HelperService,
    private loggerService: LoggerService,
    private actions: TriggerActionsService,
    private eventEmitter: EventEmitter2,
  ) {}

  // ------------------------------------------------------------------ CRUD

  /**
   * The triggers of a stage. Admins and managers (the settings page) also get `runs`: does the
   * trigger work — failed runs of the last 7 days, the last error (an error may name a client's
   * address, so not for agents).
   */
  async fetchAll(stageId: number, user: AuthUser = null): Promise<any> {
    const stage = await this.helperService.getById(DealStage, stageId, [
      'triggers',
    ]);
    const triggers = TriggerService.ordered(stage.triggers);
    const withStats = !user || new Access(user).isManager;
    const [stats, names, problems] = await Promise.all([
      withStats ? this.runStats(triggers.map((t) => t.id)) : Promise.resolve(new Map<number, any>()),
      this.fillerNames(),
      this.problemsOf(triggers),
    ]);

    return triggers.map((trigger) => {
      const item = this.modifyDataAttribute(this.withCurrentFieldNames(trigger, names));
      // what the trigger names and is gone: the settings page marks it broken
      item.problems = problems.get(trigger.id) ?? [];
      if (withStats) {
        item.runs = stats.get(trigger.id) ?? { failed: 0, last_error: null, last_failed_at: null, last_done_at: null };
      }
      return item;
    });
  }

  /** The triggers of a stage in their order (position, then id): they run in it. */
  static ordered<T extends { id: number; position?: number }>(triggers: T[]): T[] {
    return [...(triggers ?? [])].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || a.id - b.id);
  }

  async fetchOne(stageId: number, triggerId: number): Promise<any> {
    const trigger = await this.triggerRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.target_user', 't1')
      .where('t0.deal_stage_id = :stage_id', { stage_id: stageId })
      .andWhere('t0.id = :trigger_id', { trigger_id: triggerId })
      .getOne();

    if (!trigger) {
      throw new NotFoundException(
        `Trigger with id ${triggerId} does not exist or belong to stage ${stageId}`,
      );
    }

    const [names, problems] = await Promise.all([this.fillerNames(), this.problemsOf([trigger])]);
    const item = this.modifyDataAttribute(this.withCurrentFieldNames(trigger, names));
    item.problems = problems.get(trigger.id) ?? [];
    return item;
  }

  /**
   * The schedule and the history of a trigger: planned, done and failed runs, newest first.
   * A user who may not see every deal gets the runs of the deals they may see only
   * (labels of messenger deals carry the client's name and phone).
   */
  async fetchRuns(stageId: number, triggerId: number, limit = 100, user: AuthUser = null): Promise<any[]> {
    await this.fetchOne(stageId, triggerId);
    const qb = this.runRepository
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.deal', 'd')
      .where('r.trigger_id = :trigger', { trigger: triggerId })
      .orderBy('r.run_at', 'DESC')
      .addOrderBy('r.id', 'DESC')
      .limit(Math.min(Math.max(limit, 1), 500));
    if (user) {
      const access = new Access(user);
      if (!access.isManager) {
        const visible = access.dealSql('d', 'view');
        qb.andWhere(visible.sql, visible.params);
      }
    }
    const runs = await qb.getMany();
    return runs.map((run) => ({
      id: run.id,
      deal_id: run.deal?.id ?? null,
      deal_label: run.deal?.label ?? null,
      deal: run.deal ? { id: run.deal.id, label: run.deal.label } : null,
      run_at: run.run_at,
      status: run.status,
      executed_at: run.executed_at,
      // a failure in words («указан тип задачи (№5), которого больше нет»), the row keeps the original
      error: run.status === TriggerRunStatus.FAILED && run.error ? humanError(run.error) : run.error,
      note: run.note ?? null,
    }));
  }

  /** Failed runs of the last 7 days per trigger, the last error, the last success. */
  private async runStats(triggerIds: number[]): Promise<Map<number, any>> {
    if (triggerIds.length === 0) return new Map();
    const rows: any[] = await this.dataSource.query(
      `SELECT trigger_id,
              COUNT(*) FILTER (WHERE status = $3)::int AS failed,
              MAX(executed_at) FILTER (WHERE status = $3) AS last_failed_at,
              (ARRAY_AGG(error ORDER BY executed_at DESC) FILTER (WHERE status = $3))[1] AS last_error,
              MAX(executed_at) FILTER (WHERE status = $4) AS last_done_at
         FROM trigger_run
        WHERE trigger_id = ANY($1) AND executed_at > $2
        GROUP BY trigger_id`,
      [triggerIds, new Date(Date.now() - 7 * 86_400_000), TriggerRunStatus.FAILED, TriggerRunStatus.DONE],
    );
    return new Map(
      rows.map((r) => [
        Number(r.trigger_id),
        {
          failed: r.failed,
          last_error: r.last_error ? humanError(r.last_error) : null,
          last_failed_at: r.last_failed_at,
          last_done_at: r.last_done_at,
        },
      ]),
    );
  }

  private modifyDataAttribute(trigger: Trigger): any {
    const data: any = { ...trigger };
    data[this.getTargetDataAttributeName(trigger.type)] = trigger.data;
    data.kind = TriggerService.kindOf(trigger);
    delete data.data;

    return data;
  }

  async assignTriggerToDealStage(
    data: AssignTriggerDto,
    dealStageId: number,
    triggerEntity: Trigger = null,
  ): Promise<Trigger> {
    if (
      data.apply_when.time &&
      !/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(data.apply_when.time)
    ) {
      throw new BadRequestException(`Время укажите в формате ЧЧ:ММ`);
    }
    if (
      data.apply_when.when === ApplyTriggerWhenEnum.RIGHT_AWAY &&
      (data.apply_when.after_minutes ?? 0) < 0
    ) {
      throw new BadRequestException('Задержка не может быть отрицательной');
    }
    if (data.apply_when.when === ApplyTriggerWhenEnum.NO_REPLY && !(Number(data.apply_when.after_minutes) >= 1)) {
      throw new BadRequestException('Укажите, сколько минут клиент ждёт ответа (не меньше 1)');
    }

    const fillers = await this.dealFillers();
    const dealFilters = await this.normalizedFilters(data.deal_filters ?? [], fillers);
    TriggerService.assertFilterValues(dealFilters, 'Условие');

    if (data.type === TriggerTypes.CHANGE_FIELDS) {
      data.change_fields_data.fields = await this.normalizedFilters(data.change_fields_data.fields ?? [], fillers, true);
      const readOnly = (data.change_fields_data.fields ?? [])
        .filter((f) => !f.is_filler && !DEAL_COLUMNS_A_TRIGGER_MAY_CHANGE.includes(f.field))
        .map((f) => f.field);
      if (readOnly.length) {
        throw new BadRequestException(
          `Триггер может менять только ответственного, бюджет, название и доп. поля, не: ${readOnly.join(', ')}`,
        );
      }
      if (data.change_fields_data.fields.length === 0) {
        throw new BadRequestException('Добавьте хотя бы одно поле, которое триггер меняет');
      }
      TriggerService.assertFilterValues(data.change_fields_data.fields, 'Поле');
    }
    if (data.type === TriggerTypes.CREATE_DEAL && Number(data.create_deal_data?.stage_id) === Number(dealStageId)) {
      throw new BadRequestException('Триггер «Создать сделку» не может создавать сделку в своём же этапе');
    }
    if (data.type === TriggerTypes.MOVE_STAGE && Number(data.move_stage_data?.stage_id) === Number(dealStageId)) {
      throw new BadRequestException('Триггер «Перевести в этап» не может переводить сделку в её же этап');
    }
    if (data.type === TriggerTypes.SEND_EMAIL && data.send_email_data) {
      const given = (data.send_email_data.attach_extensions ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
      const kept = TriggerActionsService.normalizedExtensions(given);
      if (kept.length !== given.length) {
        throw new BadRequestException('Вложения письма: укажите расширения файлов сделки, например pdf, xlsx');
      }
      data.send_email_data.attach_extensions = kept;
    }
    if (data.type === TriggerTypes.CHANGE_AGENT) {
      const rotation = (data.change_agent_data.rotate_user_ids ?? []).map(Number).filter((id) => id > 0);
      if (rotation.length === 1) {
        throw new BadRequestException('Для раздачи по очереди выберите хотя бы двух сотрудников');
      }
      data.change_agent_data.rotate_user_ids = [...new Set(rotation)];
      if (!rotation.length && !(Number(data.change_agent_data.agent_id) > 0)) {
        throw new BadRequestException('Выберите нового ответственного');
      }
    }

    // everything the trigger names must exist: a dismissed employee, a deleted template, stage, task
    // type or field is a 400 that says which (it used to be "EmailTemplate with id 2 does not exist!")
    const candidate = Object.assign(new Trigger(), {
      id: triggerEntity?.id ?? 0,
      type: data.type,
      apply_when: data.apply_when.when,
      apply_when_data: data.apply_when,
      deal_filters: dealFilters,
      data: data[this.getTargetDataAttributeName(data.type)],
    });
    const problems = (await this.problemsOf([candidate])).get(candidate.id) ?? [];
    if (problems.length) {
      throw new BadRequestException(`Триггер не сохранён: ${problems.join('; ')}`);
    }

    if (!triggerEntity) {
      triggerEntity = new Trigger();
    }
    const isUpdate = !!triggerEntity.id;
    // the planned runs stay when only the action or the conditions change
    const scheduleBefore = isUpdate ? TriggerService.scheduleKey(triggerEntity) : null;

    triggerEntity.deal_stage = await this.helperService.getById(DealStage, dealStageId);
    // the order of the stage's triggers: as given, else the one it had, else after the others
    if (Number.isInteger(data.position) && data.position >= 0) {
      triggerEntity.position = data.position;
    } else if (!isUpdate) {
      const [row] = await this.dataSource.query(`SELECT COALESCE(MAX(position) + 1, 0)::int AS next FROM "trigger" WHERE deal_stage_id = $1`, [dealStageId]);
      triggerEntity.position = Number(row?.next ?? 0);
    }
    triggerEntity.type = data.type;
    // the queue of «по очереди» goes on where it was when the trigger is saved again
    const rotationLast = isUpdate ? triggerEntity.data?.rotation_last : undefined;
    triggerEntity.data = data[this.getTargetDataAttributeName(data.type)];
    if (rotationLast !== undefined && data.type === TriggerTypes.CHANGE_AGENT && triggerEntity.data) {
      triggerEntity.data = { ...triggerEntity.data, rotation_last: rotationLast };
    }
    triggerEntity.deal_filters = dealFilters;
    triggerEntity.apply_when = data.apply_when.when;
    triggerEntity.apply_when_data = data.apply_when;
    triggerEntity.target_user = null;

    if (EVENT_WHENS.includes(data.apply_when.when) && data.apply_when.from_user_id) {
      triggerEntity.target_user = await this.helperService.getById(User, data.apply_when.from_user_id);
    }

    // is_delayed / is_recurring are kept for the old readers; `kindOf` is the source of truth
    const kind = TriggerService.kindOf(triggerEntity);
    triggerEntity.is_delayed = kind === 'delayed';
    triggerEntity.is_recurring = kind === 'recurring' || kind === 'event';

    const saved = await this.triggerRepository.save(triggerEntity);
    if (isUpdate && scheduleBefore !== TriggerService.scheduleKey(saved)) {
      // the planned runs follow the new schedule at once (never dropped: a deal of a pipeline that is
      // not active used to lose them for good)
      await this.replanPending(saved);
    }
    // the same shape as GET: <type>_data instead of data, plus kind
    return this.modifyDataAttribute(saved);
  }

  /** What defines when the trigger runs: a change of it voids the planned runs. */
  private static scheduleKey(trigger: Pick<Trigger, 'apply_when' | 'apply_when_data'>): string {
    const d: any = trigger.apply_when_data ?? {};
    return JSON.stringify([
      trigger.apply_when,
      Number(d.after_minutes ?? 0),
      d.date ? String(d.date instanceof Date ? d.date.toISOString() : d.date).slice(0, 10) : null,
      d.time ?? null,
      d.week_day ?? null,
      d.day ?? null,
      d.month ?? null,
    ]);
  }

  /**
   * The schedule of a trigger changed: its pending runs move to the new time — a delayed one from the
   * moment its deal entered the stage, a recurring one to the next occurrence. A run the new schedule
   * has no time for (an exact time already past, the trigger is no longer delayed or recurring) is
   * skipped with that reason; the scheduler plans what is missing (planMissingDelayedRuns).
   */
  private async replanPending(trigger: Trigger): Promise<void> {
    const kind = TriggerService.kindOf(trigger);
    const pending: { id: number; deal_id: number; entered_at: Date; gone: boolean }[] = await this.dataSource.query(
      `SELECT r.id, r.deal_id, COALESCE(d.last_stage_change, d.created_at) AS entered_at,
              (d.closed_at IS NOT NULL OR d.deleted_at IS NOT NULL) AS gone
         FROM trigger_run r JOIN deal d ON d.id = r.deal_id
        WHERE r.trigger_id = $1 AND r.status = $2`,
      [trigger.id, TriggerRunStatus.PENDING],
    );
    const now = new Date();
    for (const run of pending) {
      const entered = new Date(run.entered_at);
      let at: Date | null = null;
      let key: string | null = null;
      if (run.gone) {
        // a closed or deleted deal: nothing to move (the scheduler would not plan it either)
      } else if (kind === 'delayed') {
        at = TriggerService.delayedRunAt(trigger, entered);
        key = TriggerService.runKey('delay', entered);
      } else if (kind === 'recurring') {
        at = TriggerService.nextOccurrence(trigger, now);
        key = at ? TriggerService.runKey('at', at) : null;
      }
      try {
        if (at) {
          await this.dataSource.query(`UPDATE trigger_run SET run_at = $2, run_key = $3 WHERE id = $1 AND status = $4`, [
            run.id,
            at,
            key,
            TriggerRunStatus.PENDING,
          ]);
          continue;
        }
      } catch (error) {
        // that occurrence ran already (the unique run key): this one is not needed
        this.logger.warn(`replanning run ${run.id} of trigger ${trigger.id}: ${(error as Error).message}`);
      }
      await this.dataSource.query(`UPDATE trigger_run SET status = $2, executed_at = now(), error = $3 WHERE id = $1 AND status = $4`, [
        run.id,
        TriggerRunStatus.SKIPPED,
        SCHEDULE_CHANGED,
        TriggerRunStatus.PENDING,
      ]);
    }
  }

  /**
   * The values of conditions (`what` = «Условие») or of the fields of «Изменить поля» (`what` = «Поле»):
   * a budget and the numbers of «больше» / «меньше» are numbers, a source is a known channel, a
   * responsible is an employee id (that it exists is problemsOf's), a name is not empty.
   */
  static assertFilterValues(filters: DealFilter[], what: string): void {
    const label = (f: DealFilter) =>
      f.is_filler ? `«${f.field}»` : f.field === 'budget' ? '«Бюджет»' : f.field === 'agent_id' ? '«Ответственный»' : f.field === 'label' ? '«Название»' : f.field === 'source' ? '«Источник сделки»' : `«${f.field}»`;
    const isNumber = (v: unknown) => /^\s*-?\d+([.,]\d+)?\s*$/.test(String(v ?? '').replace(/\s+/g, ''));
    for (const f of filters ?? []) {
      const value = String(f.value ?? '').trim();
      const op = f.op ?? 'eq';
      if (what === 'Поле' && op !== 'eq') throw new BadRequestException(`${what} ${label(f)}: триггер может только задать значение`);
      if ((op === 'gt' || op === 'lt') && !isNumber(value)) {
        throw new BadRequestException(`${what} ${label(f)}: для «больше» и «меньше» укажите число, а не «${value}»`);
      }
      if (f.is_filler) continue;
      if (f.field === 'budget' && !isNumber(value)) {
        throw new BadRequestException(`${what} ${label(f)}: укажите число, а не «${value}»`);
      }
      if (f.field === 'agent_id' && !/^\d+$/.test(value)) {
        throw new BadRequestException(`${what} ${label(f)}: выберите сотрудника`);
      }
      if (f.field === 'label' && !value) {
        throw new BadRequestException(`${what} ${label(f)}: название не может быть пустым`);
      }
      if (f.field === 'source' && !(DEAL_SOURCES as readonly string[]).includes(value)) {
        throw new BadRequestException(`${what} ${label(f)}: выберите канал (${Object.values(SOURCE_NAMES).join(', ')})`);
      }
      if (f.field === 'source' && op !== 'eq' && op !== 'ne') {
        throw new BadRequestException(`${what} ${label(f)}: только «равно» или «не равно»`);
      }
    }
  }

  /**
   * What the triggers name and is gone, per trigger, in words for the admin: a dismissed or deleted
   * employee (or a contact where an employee is needed), a deleted e-mail template, stage, task type or
   * custom field. Such a trigger cannot work: the settings page marks it, the admins hear of it in the
   * bot (reportBroken) and saving it again says what to fix.
   */
  async problemsOf(triggers: Trigger[]): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>();
    if (!triggers?.length) return result;
    const users = new Set<number>();
    const templates = new Set<number>();
    const stages = new Set<number>();
    const taskTypes = new Set<number>();
    const fillers = new Set<number>();
    const fillerNames = new Set<string>();
    const num = (v: unknown) => (Number(v) > 0 ? Number(v) : null);
    const add = (set: Set<number>, v: unknown) => {
      const n = num(v);
      if (n) set.add(n);
    };
    for (const t of triggers) {
      const d: any = t.data ?? {};
      add(users, (t.apply_when_data as any)?.from_user_id);
      for (const f of [...(t.deal_filters ?? []), ...(t.type === TriggerTypes.CHANGE_FIELDS ? d.fields ?? [] : [])]) {
        if (f?.is_filler && num(f.filler_id)) add(fillers, f.filler_id);
        else if (f?.is_filler) fillerNames.add(String(f.field ?? ''));
        else if (f?.field === 'agent_id') add(users, f.value);
      }
      if (t.type === TriggerTypes.CREATE_TASK) {
        add(taskTypes, d.type_id);
        add(users, d.responsible?.exact_user_id);
      }
      if (t.type === TriggerTypes.CLOSE_TASKS) add(taskTypes, d.type_id);
      if (t.type === TriggerTypes.SEND_EMAIL) {
        add(templates, d.template_id);
        add(users, d.send_to_user_id);
      }
      if (t.type === TriggerTypes.CHANGE_AGENT) {
        add(users, d.agent_id);
        (d.rotate_user_ids ?? []).forEach((id: unknown) => add(users, id));
      }
      if (t.type === TriggerTypes.CREATE_DEAL || t.type === TriggerTypes.MOVE_STAGE) add(stages, d.stage_id);
      if (t.type === TriggerTypes.NOTIFY) add(users, d.user_id);
    }
    const q = async (sql: string, ids: Set<number>) => (ids.size ? await this.dataSource.query(sql, [[...ids]]) : []);
    const [userRows, templateRows, stageRows, typeRows, fillerRows] = await Promise.all([
      q(`SELECT id, username, role, deleted_at FROM "user" WHERE id = ANY($1)`, users),
      q(`SELECT id FROM email_template WHERE id = ANY($1)`, templates),
      q(`SELECT id FROM deal_stage WHERE id = ANY($1)`, stages),
      q(`SELECT id FROM task_type WHERE id = ANY($1)`, taskTypes),
      fillers.size || fillerNames.size
        ? this.dataSource.query(`SELECT id, field FROM filler WHERE target = 'deal' AND (id = ANY($1::int[]) OR field = ANY($2::text[]))`, [
            [...fillers],
            [...fillerNames],
          ])
        : Promise.resolve([]),
    ]);
    const userById = new Map<number, any>(userRows.map((u: any) => [Number(u.id), u]));
    const has = (rows: any[], id: number) => rows.some((r) => Number(r.id) === id);
    // a custom field: by its id, else (saved before the ids) by its name
    const fieldGone = (f: any) =>
      num(f?.filler_id) ? !has(fillerRows, Number(f.filler_id)) : !fillerRows.some((r: any) => r.field === String(f?.field ?? ''));
    for (const t of triggers) {
      const d: any = t.data ?? {};
      const list: string[] = [];
      const employee = (v: unknown, what: string) => {
        const id = num(v);
        if (!id) return;
        const u = userById.get(id);
        if (!u) list.push(`${what}: сотрудник №${id} удалён`);
        else if (u.deleted_at) list.push(`${what}: «${u.username}» уволен (удалён из CRM)`);
        else if (u.role === RoleEnum.CTR_AGENT) list.push(`${what}: «${u.username}» — контакт клиента, а не сотрудник`);
      };
      employee((t.apply_when_data as any)?.from_user_id, 'сотрудник события');
      for (const f of t.deal_filters ?? []) {
        if (f?.is_filler && fieldGone(f)) list.push(`условие на поле «${f.field}», которого больше нет (удалено или переименовано)`);
        else if (!f?.is_filler && f?.field === 'agent_id') employee(f.value, 'условие «Ответственный»');
      }
      if (t.type === TriggerTypes.CHANGE_FIELDS) {
        for (const f of d.fields ?? []) {
          if (f?.is_filler && fieldGone(f)) list.push(`поле «${f.field}» больше не существует (удалено или переименовано)`);
          else if (!f?.is_filler && f?.field === 'agent_id') employee(f.value, 'новый ответственный');
        }
      }
      if (t.type === TriggerTypes.CREATE_TASK) {
        if (num(d.type_id) && !has(typeRows, Number(d.type_id))) list.push(`тип задачи №${d.type_id} удалён`);
        employee(d.responsible?.exact_user_id, 'исполнитель задачи');
      }
      if (t.type === TriggerTypes.CLOSE_TASKS && num(d.type_id) && !has(typeRows, Number(d.type_id))) {
        list.push(`тип задачи №${d.type_id} удалён`);
      }
      if (t.type === TriggerTypes.SEND_EMAIL) {
        if (!num(d.template_id)) list.push('не выбран шаблон письма');
        else if (!has(templateRows, Number(d.template_id))) list.push(`шаблон письма №${d.template_id} удалён`);
        employee(d.send_to_user_id, 'получатель письма');
      }
      if (t.type === TriggerTypes.CHANGE_AGENT) {
        employee(d.agent_id, 'новый ответственный');
        (d.rotate_user_ids ?? []).forEach((id: unknown) => employee(id, 'очередь раздачи'));
      }
      if (t.type === TriggerTypes.CREATE_DEAL || t.type === TriggerTypes.MOVE_STAGE) {
        if (!num(d.stage_id)) list.push('не выбран этап');
        else if (!has(stageRows, Number(d.stage_id))) list.push(`этап №${d.stage_id} удалён`);
      }
      if (t.type === TriggerTypes.NOTIFY) employee(d.user_id, 'получатель уведомления');
      if (list.length) result.set(t.id, list);
    }
    return result;
  }

  /**
   * Broken triggers are told to the admins (TRIGGER_BROKEN -> the CRM bot): an employee was dismissed or
   * a template deleted, and the automation stopped in silence. Checked every 10 minutes; each trigger at
   * most once a day, all of a check in one message.
   */
  private async reportBroken(): Promise<void> {
    if (Date.now() - this.lastBrokenCheck < BROKEN_CHECK_EVERY_MS) return;
    this.lastBrokenCheck = Date.now();
    try {
      const triggers = await this.triggerRepository.find({ relations: { deal_stage: true } });
      const problems = await this.problemsOf(triggers);
      const fresh: TriggerBrokenReport[] = [];
      for (const trigger of TriggerService.ordered(triggers)) {
        const list = problems.get(trigger.id);
        if (!list?.length) {
          this.brokenTold.delete(trigger.id);
          continue;
        }
        const told = this.brokenTold.get(trigger.id) ?? 0;
        if (Date.now() - told < BROKEN_TELL_EVERY_MS) continue;
        this.brokenTold.set(trigger.id, Date.now());
        this.logger.warn(`trigger ${trigger.id} is broken: ${list.join('; ')}`);
        fresh.push({
          trigger_id: trigger.id,
          action: ACTION_NAMES[trigger.type] ?? 'действие',
          stage_id: trigger.deal_stage?.id ?? null,
          stage_name: trigger.deal_stage?.name ?? null,
          problems: list,
        });
      }
      if (fresh.length) this.eventEmitter.emit(TRIGGER_BROKEN, { triggers: fresh } as TriggerBrokenSummary);
    } catch (error) {
      this.logger.warn(`broken triggers check: ${(error as Error).message}`);
    }
  }

  /** GET /triggers/email-templates: every template, with its author (a trigger may send any of them). */
  async emailTemplates(): Promise<{ id: number; name: string; subject: string; owner: string | null }[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT t.id, t.name, t.subject, u.username AS owner
         FROM email_template t LEFT JOIN "user" u ON u.id = t.created_by
        ORDER BY LOWER(COALESCE(t.name, t.subject, '')), t.id`,
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.name || r.subject || `Шаблон №${r.id}`, subject: r.subject ?? '', owner: r.owner ?? null }));
  }

  /** GET /triggers/stages: the stages of every pipeline, the active pipeline first. */
  async allStages(): Promise<{ id: number; name: string; collection_id: number | null; collection: string | null; is_active: boolean }[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT s.id, s.name, s.collection_id, c.name AS collection, COALESCE(c.is_active, false) AS is_active
         FROM deal_stage s LEFT JOIN collection c ON c.id = s.collection_id
        ORDER BY COALESCE(c.is_active, false) DESC, c.id, s."order", s.id`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      collection_id: r.collection_id === null ? null : Number(r.collection_id),
      collection: r.collection ?? null,
      is_active: !!r.is_active,
    }));
  }

  /** GET /triggers/broken: every trigger that names something gone, with what. */
  async brokenTriggers(): Promise<{ id: number; stage_id: number; stage: string; action: string; problems: string[] }[]> {
    const triggers = await this.triggerRepository.find({ relations: { deal_stage: true } });
    const problems = await this.problemsOf(triggers);
    return TriggerService.ordered(triggers)
      .filter((t) => problems.has(t.id))
      .map((t) => ({
        id: t.id,
        stage_id: t.deal_stage?.id ?? null,
        stage: t.deal_stage?.name ?? null,
        action: ACTION_NAMES[t.type] ?? 'действие',
        problems: problems.get(t.id) ?? [],
      }));
  }

  /**
   * PATCH /stages/:id/trigger-order: the triggers of the stage in this order (they run in it). Only the
   * order changes: a trigger that names something deleted can still be moved (saving it would be a 400).
   * `ids` must be exactly the triggers of the stage.
   */
  async reorderTriggers(stageId: number, ids: number[]): Promise<{ id: number; position: number }[]> {
    const own = await this.triggerRepository.find({ where: { deal_stage: { id: stageId } } });
    const given = (ids ?? []).map(Number);
    const mine = new Map(own.map((t) => [t.id, t]));
    if (given.length !== mine.size || new Set(given).size !== given.length || given.some((id) => !mine.has(id))) {
      throw new BadRequestException('Порядок триггеров: укажите все триггеры этого этапа, каждый один раз');
    }
    // through the entities (only the ones that move): the journal and the live updates see the change
    const moved = given.map((id, position) => ({ trigger: mine.get(id), position })).filter((x) => Number(x.trigger.position) !== x.position);
    for (const { trigger, position } of moved) {
      await this.triggerRepository.update(trigger.id, { position });
    }
    return given.map((id, position) => ({ id, position }));
  }

  async updateTrigger(id: number, dealStageId: number, data: AssignTriggerDto): Promise<void> {
    const triggerEntity = await this.helperService.getById(Trigger, id, ['deal_stage', 'target_user']);
    if (triggerEntity.deal_stage.id !== dealStageId) {
      throw new BadRequestException(`Trigger: ${id} does not belong to stage ${dealStageId}`);
    }
    await this.assignTriggerToDealStage(data, dealStageId, triggerEntity);
  }

  async deleteTrigger(id: number, dealStageId: number): Promise<void> {
    const triggerEntity = await this.helperService.getById(Trigger, id, ['deal_stage', 'target_user']);

    if (triggerEntity.deal_stage.id !== dealStageId) {
      throw new BadRequestException(`Trigger: ${id} does not belong to stage ${dealStageId}`);
    }

    // trigger_run rows go with it (ON DELETE CASCADE)
    await this.triggerRepository.delete({ id });
  }

  private dealFillers(): Promise<Filler[]> {
    return this.dataSource.getRepository(Filler).find({ where: { target: 'deal' } });
  }

  private async fillerNames(): Promise<Map<number, string>> {
    return new Map((await this.dealFillers()).map((f) => [f.id, f.field]));
  }

  /**
   * Conditions (or the fields of "change fields", `withLabel`: the settings page shows their label) as
   * they are stored: a custom field with its id and current name, so that renaming the field keeps
   * the trigger. Unknown fields: 400 with their names.
   */
  private async normalizedFilters(filters: DealFilter[], fillers: Filler[], withLabel = false): Promise<DealFilter[]> {
    const columns = (await this.helperService.getDealColumns()).filter((c) => !c.is_filler).map((c) => c.field);
    const invalid: string[] = [];
    const result: DealFilter[] = [];
    for (const f of filters ?? []) {
      if (f.is_filler) {
        const filler =
          (f.filler_id ? fillers.find((x) => x.id === Number(f.filler_id)) : undefined) ??
          fillers.find((x) => x.field === f.field);
        if (!filler) {
          invalid.push(f.field);
          continue;
        }
        const kept: any = { field: filler.field, value: f.value, is_filler: true, filler_id: filler.id };
        if (f.op && f.op !== 'eq') kept.op = f.op;
        if (withLabel) kept.label = filler.field;
        result.push(kept);
      } else {
        // `source`: the channel the deal came from (not a column, TriggerActionsService.getTargetDeal)
        if (!columns.includes(f.field) && f.field !== 'source') {
          invalid.push(f.field);
          continue;
        }
        const kept: any = { field: f.field, value: f.value, is_filler: false };
        if (f.op && f.op !== 'eq') kept.op = f.op;
        if (withLabel && (f as any).label) kept.label = (f as any).label;
        result.push(kept);
      }
    }
    if (invalid.length) {
      throw new BadRequestException(`Условия триггера ссылаются на поля, которых нет: ${invalid.join(', ')}`);
    }
    return result;
  }

  async throwIfInvalidDealFiltersProvided(dealFilters: DealFilter[]): Promise<void> {
    await this.normalizedFilters(dealFilters ?? [], await this.dealFillers());
  }

  /** The trigger with the current names of its custom fields (they are kept by id). */
  private withCurrentFieldNames(trigger: Trigger, names: Map<number, string>): Trigger {
    const rename = (list: DealFilter[]) =>
      (list ?? []).map((f: any) => {
        if (!f?.is_filler || !f.filler_id || !names.has(Number(f.filler_id))) return f;
        const name = names.get(Number(f.filler_id));
        return f.label !== undefined ? { ...f, field: name, label: name } : { ...f, field: name };
      });
    const copy = Object.assign(Object.create(Object.getPrototypeOf(trigger)), trigger) as Trigger;
    copy.deal_filters = rename(trigger.deal_filters);
    if (trigger.type === TriggerTypes.CHANGE_FIELDS && trigger.data?.fields) {
      copy.data = { ...trigger.data, fields: rename(trigger.data.fields) };
    }
    return copy;
  }

  getTargetDataAttributeName(type: TriggerTypes): string {
    switch (type) {
      case TriggerTypes.CLOSE_TASKS:
        return 'close_tasks_data';
      case TriggerTypes.CHANGE_AGENT:
        return 'change_agent_data';
      case TriggerTypes.DELETE_FILES:
        return 'delete_files_data';
      case TriggerTypes.CREATE_DEAL:
        return 'create_deal_data';
      case TriggerTypes.CHANGE_FIELDS:
        return 'change_fields_data';
      case TriggerTypes.CREATE_TASK:
        return 'create_task_data';
      case TriggerTypes.SEND_EMAIL:
        return 'send_email_data';
      case TriggerTypes.MOVE_STAGE:
        return 'move_stage_data';
      case TriggerTypes.NOTIFY:
        return 'notify_data';
      default:
        throw new BadRequestException(`Provided invalid trigger type`);
    }
  }

  // ------------------------------------------------------------------ when

  static kindOf(trigger: Pick<Trigger, 'apply_when' | 'apply_when_data'>): TriggerKind {
    const when = trigger.apply_when;
    if (EVENT_WHENS.includes(when) || WAITING_WHENS.includes(when)) return 'event';
    if (RECURRING_WHENS.includes(when)) return 'recurring';
    if (when === ApplyTriggerWhenEnum.EXACT_TIME) return 'delayed';
    if (Number(trigger.apply_when_data?.after_minutes ?? 0) > 0) return 'delayed';
    return 'immediate';
  }

  /**
   * How often a trigger may act for one deal (the recurring ones follow their schedule):
   * only once ever (default: "create deal" — a deal that comes back to the stage gets no second
   * copy) and not again within `cooldown_minutes` (default: a day for "send email").
   */
  static repeatRule(trigger: Pick<Trigger, 'type' | 'apply_when' | 'apply_when_data'>): { once: boolean; cooldownMinutes: number } {
    const data: any = trigger.apply_when_data ?? {};
    const once = typeof data.once_per_deal === 'boolean' ? data.once_per_deal : trigger.type === TriggerTypes.CREATE_DEAL;
    let cooldownMinutes = 0;
    if (TriggerService.kindOf(trigger) !== 'recurring') {
      const given = data.cooldown_minutes;
      const set = given !== undefined && given !== null && given !== '' && Number.isFinite(Number(given));
      cooldownMinutes = set ? Math.max(0, Number(given)) : trigger.type === TriggerTypes.SEND_EMAIL ? 24 * 60 : 0;
    }
    return { once, cooldownMinutes };
  }

  private static parseTime(time?: string): [number, number] {
    const [h, m] = String(time || '00:00').split(':').map(Number);
    return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0];
  }

  /**
   * When a delayed trigger fires for a deal that entered the stage at `enteredAt`; null = never.
   * "At an exact time" is for the deals that are in the stage at that time: a deal that comes
   * after it gets no run (it used to get a run skipped as missed, one row per deal).
   */
  static delayedRunAt(trigger: Trigger, enteredAt: Date): Date | null {
    const data = trigger.apply_when_data ?? ({} as any);
    if (trigger.apply_when === ApplyTriggerWhenEnum.EXACT_TIME) {
      // "2026-11-24" (what the form sends) is that day here: new Date() reads it as UTC midnight,
      // which is the day before west of UTC; a full timestamp keeps its local day
      const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(data.date ?? '').trim());
      const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(data.date);
      if (isNaN(date.getTime())) return null;
      const [h, m] = TriggerService.parseTime(data.time);
      date.setHours(h, m, 0, 0);
      return date.getTime() > enteredAt.getTime() ? date : null;
    }
    // exactly N minutes after entering (it used to be rounded down to the minute: up to 59 s early)
    return new Date(enteredAt.getTime() + Number(data.after_minutes ?? 0) * 60_000);
  }

  /** The run key of `what` (enter, delay, at) at a moment: one execution per entry, stay or occurrence. */
  static runKey(what: string, at: Date | string | number | null | undefined): string | null {
    const ms = at instanceof Date ? at.getTime() : at === null || at === undefined ? NaN : new Date(at).getTime();
    return Number.isFinite(ms) ? `${what}:${ms}` : null;
  }

  /** When the deal entered its current stage (the key of the runs of this stay). */
  private static enteredAt(deal: Deal): Date {
    const at = deal?.last_stage_change ?? deal?.created_at;
    const date = at ? new Date(at) : null;
    return date && Number.isFinite(date.getTime()) ? date : new Date();
  }

  /** The next occurrence of a recurring trigger strictly after `after`. */
  static nextOccurrence(trigger: Pick<Trigger, 'apply_when' | 'apply_when_data'>, after: Date): Date | null {
    const data = trigger.apply_when_data ?? ({} as any);
    const [h, m] = TriggerService.parseTime(data.time);
    const at = (y: number, mo: number, d: number) => {
      const date = new Date(y, mo, 1, h, m, 0, 0);
      const last = new Date(y, mo + 1, 0).getDate();
      date.setDate(Math.min(d, last));
      return date;
    };
    switch (trigger.apply_when) {
      case ApplyTriggerWhenEnum.EVERY_DAY: {
        let date = at(after.getFullYear(), after.getMonth(), after.getDate());
        if (date <= after) date = at(after.getFullYear(), after.getMonth(), after.getDate() + 1);
        return date;
      }
      case ApplyTriggerWhenEnum.EVERY_WEEK: {
        const target = Number(data.week_day || 1); // 1 = Monday .. 7 = Sunday
        const current = after.getDay() === 0 ? 7 : after.getDay();
        let days = target - current;
        if (days < 0) days += 7;
        let date = at(after.getFullYear(), after.getMonth(), after.getDate() + days);
        if (date <= after) date = at(after.getFullYear(), after.getMonth(), after.getDate() + days + 7);
        return date;
      }
      case ApplyTriggerWhenEnum.EVERY_MONTH: {
        const day = Number(data.day || 1);
        let date = at(after.getFullYear(), after.getMonth(), day);
        if (date <= after) date = at(after.getFullYear(), after.getMonth() + 1, day);
        return date;
      }
      case ApplyTriggerWhenEnum.EVERY_YEAR: {
        const day = Number(data.day || 1);
        const month = Number(data.month || 1) - 1;
        let date = at(after.getFullYear(), month, day);
        if (date <= after) date = at(after.getFullYear() + 1, month, day);
        return date;
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ entry points

  /**
   * The deal was created in or moved to `stage`: immediate triggers run now (a letter right after
   * the request), delayed and recurring ones are planned; pending runs of other stages are cancelled.
   */
  async onDealEnteredStage(
    originatedBy: User,
    deal: Deal,
    stage: DealStage,
    chain: TriggerChain = NO_CHAIN,
  ): Promise<void> {
    if (!stage) return;
    let queued = 0;
    try {
      await this.cancelRunsOfOtherStages(deal.id, stage.id);
      const triggers = await this.triggersOfStage(stage.id);
      const now = new Date();
      // this entry into the stage: its runs are keyed by it, so that one entry executes a trigger once
      const entered = TriggerService.enteredAt(deal);
      const enterKey = TriggerService.runKey('enter', entered);
      for (const trigger of triggers) {
        const kind = TriggerService.kindOf(trigger);
        if (kind === 'immediate') {
          const blocked = await this.repeatBlock(trigger, deal.id);
          if (blocked) {
            await this.recordSkipped(trigger.id, deal.id, blocked.reason);
            continue;
          }
          if (trigger.type === TriggerTypes.SEND_EMAIL) {
            // a letter waits for the mail server (seconds, up to a minute): it is queued, due now,
            // and sent right after this request instead of holding the kanban
            if (await this.planRun(trigger, deal, now, enterKey)) queued++;
            continue;
          }
          const outcome = await this.executeRecorded(originatedBy, deal, trigger, chain, enterKey);
          // «перевести в этап» took the deal away: the other triggers of this stage are not for it
          if (outcome?.moved) break;
        } else if (kind === 'delayed') {
          // from the moment of the entry: the same one the scheduler and the replanning count from
          const runAt = TriggerService.delayedRunAt(trigger, entered);
          if (runAt) await this.planRun(trigger, deal, runAt, TriggerService.runKey('delay', entered));
        } else if (kind === 'recurring') {
          const runAt = TriggerService.nextOccurrence(trigger, now);
          if (runAt) await this.planRun(trigger, deal, runAt, TriggerService.runKey('at', runAt));
        }
      }
    } catch (error) {
      this.loggerService.error(`triggers of stage ${stage.id} for deal ${deal.id}`, (error as Error).stack);
      this.logger.error(`triggers of stage ${stage.id} for deal ${deal.id}: ${(error as Error).message}`);
    }
    if (queued) this.executeQueuedSoon();
  }

  /**
   * The queued letters go out right after the current request, not at the next tick of the
   * scheduler (one pass for everything queued meanwhile). Safe next to a tick: every row is
   * taken by one UPDATE (claim).
   */
  private executeQueuedSoon(): void {
    if (this.queuedPass) return;
    this.queuedPass = true;
    setTimeout(() => {
      this.queuedPass = false;
      this.executeDueRuns().catch((error) =>
        this.logger.warn(`queued trigger runs: ${(error as Error).message}`),
      );
    }, 0);
  }

  /** Kept for the old callers: immediate triggers of a stage (with the same limits on repeats). */
  async handleTriggers(originatedBy: User, deal: Deal, triggers: Trigger[] = []): Promise<void> {
    for (const trigger of TriggerService.ordered(triggers)) {
      if (TriggerService.kindOf(trigger) !== 'immediate') continue;
      const blocked = await this.repeatBlock(trigger, deal.id);
      if (blocked) await this.recordSkipped(trigger.id, deal.id, blocked.reason);
      else await this.executeRecorded(originatedBy, deal, trigger, NO_CHAIN, TriggerService.runKey('enter', TriggerService.enteredAt(deal)));
    }
  }

  /** A call recording was linked to a deal: the "записан звонок" triggers of its stage. */
  @OnEvent(EventTypes.NEW_CALL_RECORDING.toString())
  async onCallRecorded(data: CallRecordingEventDto): Promise<void> {
    if (!data?.deal?.id || data.history) return;
    try {
      // a call event: originated_by is the contact, target_user the manager on the call; the
      // direction is read as the history reads it (EventListener: not false = outgoing)
      const outgoing = data.recording?.outgoing !== false;
      await this.onDealEvent(data.target_user ?? data.originated_by, data.deal, ApplyTriggerWhenEnum.CALL_RECORDED, {
        outgoing,
        from_user_id: outgoing ? data.target_user?.id : data.originated_by?.id,
        staff_user_id: data.target_user?.id ?? data.recording?.user?.id,
      });
    } catch (error) {
      this.logger.warn(`call triggers of deal ${data.deal.id}: ${(error as Error).message}`);
    }
  }

  /** An email arrived or was sent in a deal: the "при письме" triggers of its stage. */
  @OnEvent(EventTypes.NEW_EMAIL.toString())
  async onEmailEvent(data: EmailEventDto[] | EmailEventDto): Promise<void> {
    const items = Array.isArray(data) ? data : [data];
    // one letter comes for each open deal of its sender (one batch): a "send email" trigger answers it once
    const fired = new Set<string>();
    for (const item of items) {
      if (!item?.deal?.id) continue;
      if (!TriggerService.emailMayFire(item.email)) continue;
      const letter = item.email?.message_id || (item.email?.id ? `#${item.email.id}` : undefined);
      try {
        // originated_by: the sender of an outgoing letter, the contact of an incoming one
        await this.onDealEvent(item.originated_by, item.deal, ApplyTriggerWhenEnum.EMAIL_RECEIVED, {
          outgoing: item.email?.outgoing,
          from_user_id: item.originated_by?.id ?? item.email?.from_user?.id,
          once_key: letter,
          fired,
        });
      } catch (error) {
        this.logger.warn(`email triggers of deal ${item.deal.id}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * A letter that may fire "при письме": not older than TRIGGER_EMAIL_MAX_AGE_HOURS (the first sync
   * of a mailbox replays years of mail), not spam or deleted, not an answering machine's or a
   * mail server's bounce.
   */
  static emailMayFire(email: Email | undefined, now = Date.now()): boolean {
    if (!email) return true;
    if (email.is_spam || email.deleted_at) return false;
    const sent = email.sent_at ? new Date(email.sent_at).getTime() : NaN;
    if (Number.isFinite(sent) && now - sent > EMAIL_MAX_AGE_HOURS * 3_600_000) return false;
    if (!email.outgoing) {
      const subject = email.subject ?? '';
      if (AUTO_REPLY_SUBJECT.test(subject) || BOUNCE_SUBJECT.test(subject)) return false;
      if (BOUNCE_SENDER.test(email.from ?? '')) return false;
    }
    return true;
  }

  /**
   * Something happened in the deal (a Telegram or WhatsApp message, an email, a call):
   * the triggers of its current stage that wait for this event run.
   * Never on what a trigger's action produced (no loops: its letter, in this deal or another one);
   * a message that does not fit a trigger's conditions, or comes within its pause, leaves no row
   * (one per message would flood the history).
   */
  async onDealEvent(
    originatedBy: User,
    deal: Deal,
    when: ApplyTriggerWhenEnum,
    context: DealEventContext = {},
  ): Promise<number> {
    const acting = TriggerService.acting.getStore();
    if (acting) {
      // the event comes from the action of a trigger (its letter): never a reason for another run
      this.logger.debug(`event of deal ${deal.id} made by trigger ${acting.trigger_id}: no triggers`);
      return 0;
    }
    const stageId = deal.stage?.id ?? (await this.stageIdOf(deal.id));
    if (!stageId) return 0;
    const triggers = (await this.triggersOfStage(stageId)).filter((t) => t.apply_when === when);
    let fired = 0;
    let queued = 0;
    let staff: number | null | undefined;
    for (const trigger of triggers) {
      const data = trigger.apply_when_data ?? ({} as any);
      if (typeof data.outgoing === 'boolean' && context.outgoing !== undefined && data.outgoing !== context.outgoing) {
        continue;
      }
      if (data.from_user_id) {
        if (staff === undefined) staff = await this.staffOf(deal, context);
        if (Number(data.from_user_id) !== Number(staff)) continue;
      }
      // the same letter in another open deal of the client: already answered
      const answered =
        trigger.type === TriggerTypes.SEND_EMAIL && context.once_key && context.fired
          ? `${trigger.id}:${context.once_key}`
          : null;
      if (answered && context.fired.has(answered)) continue;
      if (await this.actions.precheck(deal, trigger)) continue;
      const blocked = await this.repeatBlock(trigger, deal.id);
      if (blocked) {
        // the daily limit is worth one visible row a day; a pause or "once" is the normal case
        if (blocked.limit) await this.recordLimitOnce(trigger.id, deal.id, blocked.reason);
        continue;
      }
      // one message is one execution even when it comes twice (a re-sync of the mailbox)
      const key = context.once_key ? `event:${String(context.once_key).slice(0, 100)}` : null;
      if (trigger.type === TriggerTypes.SEND_EMAIL) {
        // the letter is queued and sent right after: the incoming message is not held by the mail
        // server; a letter already waiting in the queue for this deal is not queued twice
        if (await this.planRun(trigger, deal, new Date(), key)) queued++;
      } else {
        await this.executeRecorded(originatedBy, deal, trigger, NO_CHAIN, key);
      }
      if (answered) context.fired.add(answered);
      fired++;
    }
    if (queued) this.executeQueuedSoon();
    return fired;
  }

  /** The employee of an event: given, else the author of an outgoing one, else the responsible of the deal. */
  private async staffOf(deal: Deal, context: DealEventContext): Promise<number | null> {
    if (context.staff_user_id) return Number(context.staff_user_id);
    if (context.outgoing && context.from_user_id) return Number(context.from_user_id);
    if (deal.agent?.id) return deal.agent.id;
    const row = await this.dealRepository
      .createQueryBuilder('d')
      .select('d.agent_id', 'agent_id')
      .where('d.id = :id', { id: deal.id })
      .getRawOne();
    return row?.agent_id ?? null;
  }

  // ------------------------------------------------------------------ repeats

  /**
   * Why the trigger must not act for the deal now (null = it may): it acts only once and did,
   * its pause after the last action has not passed, or it reached the daily limit (`limit`).
   * A run that is executing right now (two messages at once) counts as done.
   */
  private async repeatBlock(trigger: Trigger, dealId: number, exceptRunId = 0): Promise<{ reason: string; limit: boolean } | null> {
    const rule = TriggerService.repeatRule(trigger);
    const max = trigger.type === TriggerTypes.SEND_EMAIL ? MAX_EMAILS_PER_DEAL_DAY : MAX_RUNS_PER_DEAL_DAY;
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ($3, $4, $5) AND executed_at > $6)::int AS day,
              MAX(executed_at) FILTER (WHERE status IN ($3, $5)) AS last_done,
              COUNT(*) FILTER (WHERE status IN ($3, $5))::int AS done
         FROM trigger_run
        WHERE trigger_id = $1 AND deal_id = $2 AND id <> $7`,
      [
        trigger.id,
        dealId,
        TriggerRunStatus.DONE,
        TriggerRunStatus.FAILED,
        TriggerRunStatus.RUNNING,
        new Date(Date.now() - 86_400_000),
        exceptRunId,
      ],
    );
    if (rule.once && Number(row?.done) > 0) {
      return { reason: 'уже выполнялся для этой сделки (только один раз)', limit: false };
    }
    if (rule.cooldownMinutes > 0 && row?.last_done && Date.now() - new Date(row.last_done).getTime() < rule.cooldownMinutes * 60_000) {
      return { reason: `не чаще раза в ${minutesText(rule.cooldownMinutes)} для сделки`, limit: false };
    }
    if (Number(row?.day) >= max) {
      return { reason: `лимит: не больше ${max} срабатываний за сутки для одной сделки`, limit: true };
    }
    return null;
  }

  private async recordSkipped(triggerId: number, dealId: number, reason: string): Promise<void> {
    try {
      const now = new Date();
      await this.dataSource.query(
        `INSERT INTO trigger_run (trigger_id, deal_id, run_at, status, executed_at, error) VALUES ($1, $2, $3, $4, $3, $5)`,
        [triggerId, dealId, now, TriggerRunStatus.SKIPPED, reason.slice(0, 2000)],
      );
    } catch (error) {
      this.logger.warn(`cannot record a skipped run of trigger ${triggerId}: ${(error as Error).message}`);
    }
  }

  private async recordLimitOnce(triggerId: number, dealId: number, reason: string): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM trigger_run WHERE trigger_id = $1 AND deal_id = $2 AND status = $3 AND error = $4 AND executed_at > $5 LIMIT 1`,
      [triggerId, dealId, TriggerRunStatus.SKIPPED, reason, new Date(Date.now() - 86_400_000)],
    );
    if (rows.length === 0) {
      this.logger.warn(`trigger ${triggerId} reached its daily limit for deal ${dealId}`);
      await this.recordSkipped(triggerId, dealId, reason);
    }
  }

  // ------------------------------------------------------------------ schedule

  private async triggersOfStage(stageId: number): Promise<Trigger[]> {
    return this.triggerRepository.find({
      where: { deal_stage: { id: stageId } },
      relations: { deal_stage: true, target_user: true },
      order: { position: 'ASC', id: 'ASC' },
    });
  }

  private async stageIdOf(dealId: number): Promise<number | null> {
    const row = await this.dealRepository
      .createQueryBuilder('d')
      .select('d.stage_id', 'stage_id')
      .where('d.id = :id', { id: dealId })
      .getRawOne();
    return row?.stage_id ?? null;
  }

  private async cancelRunsOfOtherStages(dealId: number, stageId: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE trigger_run r SET status = $1, executed_at = now(), error = $5
         FROM trigger t
        WHERE t.id = r.trigger_id AND r.deal_id = $2 AND r.status = $3 AND t.deal_stage_id <> $4`,
      [TriggerRunStatus.SKIPPED, dealId, TriggerRunStatus.PENDING, stageId, LEFT_STAGE],
    );
  }

  /**
   * One pending run per trigger and deal: one statement, and the unique partial index
   * IDX_trigger_run_pending catches the planning from a request and from the scheduler at once.
   */
  async planRun(trigger: Trigger, deal: Deal, runAt: Date, key: string | null = null): Promise<TriggerRun | null> {
    // the run key (one entry, stay or occurrence) makes a second planning of the same thing a no-op too
    const rows: { id: number }[] = await this.dataSource.query(
      `INSERT INTO trigger_run (trigger_id, deal_id, run_at, status, run_key)
       SELECT $1::int, $2::int, $3::timestamp, $4::varchar, $5::varchar
        WHERE NOT EXISTS (SELECT 1 FROM trigger_run r WHERE r.trigger_id = $1::int AND r.deal_id = $2::int AND r.status = $4::varchar)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [trigger.id, deal.id, runAt, TriggerRunStatus.PENDING, key],
    );
    if (!rows?.length) return null;
    return Object.assign(new TriggerRun(), { id: rows[0].id, trigger, deal, run_at: runAt, status: TriggerRunStatus.PENDING });
  }

  /**
   * Triggers of the stages of every pipeline: a deal lives on in a pipeline that is not the active one
   * (production, a second sales line), and its delayed and recurring runs must not be lost.
   */
  private activeTriggers(): Promise<Trigger[]> {
    return this.triggerRepository
      .createQueryBuilder('t')
      .innerJoinAndSelect('t.deal_stage', 's')
      .orderBy('t.position', 'ASC')
      .addOrderBy('t.id', 'ASC')
      .getMany();
  }

  /**
   * Scheduler: delayed runs that are missing. A deal in the stage without a run of the trigger
   * for its current stay (it got there past the API, the API was down at that moment, or the
   * trigger was changed) is planned from the moment it entered the stage (last_stage_change,
   * else created_at); a run of an earlier stay does not count. Deals that entered before the
   * trigger was created are left alone: the trigger did not exist for them.
   */
  async planMissingDelayedRuns(): Promise<number> {
    const triggers = (await this.activeTriggers()).filter((t) => TriggerService.kindOf(t) === 'delayed');
    let planned = 0;
    for (const trigger of triggers) {
      if (trigger.apply_when === ApplyTriggerWhenEnum.EXACT_TIME) {
        // a date long past can plan nothing that would still run: no query for it on every tick
        const at = TriggerService.delayedRunAt(trigger, new Date(0));
        if (!at || Date.now() - at.getTime() > MISSED_AFTER_MINUTES * 60_000) continue;
      }
      // "after N minutes" is about entering the stage, so deals that entered before the trigger
      // existed are left alone; "at an exact time" is for every deal that is in the stage then.
      // All timestamps are in one zone (migration 1794960000000-time-zone), compared as they are.
      const deals: { id: number; entered_at: Date }[] = await this.dataSource.query(
        `SELECT d.id, COALESCE(d.last_stage_change, d.created_at) AS entered_at
           FROM deal d
          WHERE d.stage_id = $1 AND d.closed_at IS NULL AND d.deleted_at IS NULL
            AND ($3::boolean OR COALESCE(d.last_stage_change, d.created_at) >= (SELECT t.created_at FROM "trigger" t WHERE t.id = $2))
            AND NOT EXISTS (SELECT 1 FROM trigger_run r
                             WHERE r.trigger_id = $2 AND r.deal_id = d.id
                               AND (r.status IN ($4, $5) OR r.created_at >= COALESCE(d.last_stage_change, d.created_at)))`,
        [
          trigger.deal_stage.id,
          trigger.id,
          trigger.apply_when === ApplyTriggerWhenEnum.EXACT_TIME,
          TriggerRunStatus.PENDING,
          TriggerRunStatus.RUNNING,
        ],
      );
      for (const deal of deals) {
        const entered = new Date(deal.entered_at);
        const runAt = TriggerService.delayedRunAt(trigger, entered);
        if (runAt && (await this.planRun(trigger, { id: deal.id } as Deal, runAt, TriggerService.runKey('delay', entered)))) planned++;
      }
    }
    return planned;
  }

  /** Scheduler: every open deal in a stage with recurring triggers has its next run planned (one statement per trigger). */
  async planRecurringRuns(): Promise<number> {
    const triggers = (await this.activeTriggers()).filter((t) => RECURRING_WHENS.includes(t.apply_when));
    let planned = 0;
    const now = new Date();
    for (const trigger of triggers) {
      const runAt = TriggerService.nextOccurrence(trigger, now);
      if (!runAt) continue;
      const rows: any[] = await this.dataSource.query(
        `INSERT INTO trigger_run (trigger_id, deal_id, run_at, status, run_key)
         SELECT $1::int, d.id, $2::timestamp, $3::varchar, $6::varchar
           FROM deal d
          WHERE d.stage_id = $4 AND d.closed_at IS NULL AND d.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM trigger_run r WHERE r.trigger_id = $1::int AND r.deal_id = d.id AND r.status IN ($3::varchar, $5::varchar))
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [trigger.id, runAt, TriggerRunStatus.PENDING, trigger.deal_stage.id, TriggerRunStatus.RUNNING, TriggerService.runKey('at', runAt)],
      );
      planned += rows?.length ?? 0;
    }
    return planned;
  }

  /**
   * One tick of the schedule by hand (POST /triggers/run-due) or from the scheduler. One tick at a time
   * in the whole installation (a PostgreSQL advisory lock: two API processes during a deploy, or
   * run-due during a tick): the other one returns at once with `busy`. Each run is still taken by one
   * UPDATE and keyed (exactly once), the lock only keeps the planning passes from racing.
   */
  async runDue(): Promise<{ planned: number; executed: number; failed: number; skipped: number; busy?: boolean }> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [row] = await runner.query(`SELECT pg_try_advisory_lock($1) AS locked`, [TICK_LOCK]);
      if (!row?.locked) return { planned: 0, executed: 0, failed: 0, skipped: 0, busy: true };
      try {
        const planned = (await this.planMissingDelayedRuns()) + (await this.planRecurringRuns());
        const outcome = await this.executeDueRuns();
        const waiting = await this.runNoReply();
        await this.cleanupOldRuns();
        await this.reportBroken();
        return { planned, ...outcome, executed: outcome.executed + waiting };
      } finally {
        await runner.query(`SELECT pg_advisory_unlock($1)`, [TICK_LOCK]).catch(() => undefined);
      }
    } finally {
      await runner.release();
    }
  }

  /**
   * «Нет ответа N минут»: the client wrote (Telegram, WhatsApp, e-mail, SMS) and nobody answered or
   * called back (the rule of «Контроль менеджеров»: clientMessageSql / answerSql) for N working minutes
   * (CONTROL_WORK_HOURS / CONTROL_WORK_DAYS). Once per client message (run key noreply:<event>), only for
   * messages of the last 3 days and open deals of the trigger's stage; the conditions and repeats of the
   * trigger apply. Returns how many runs were done.
   */
  async runNoReply(now = new Date()): Promise<number> {
    const triggers = (await this.activeTriggers()).filter((t) => t.apply_when === ApplyTriggerWhenEnum.NO_REPLY);
    if (triggers.length === 0) return 0;
    const schedule = new WorkSchedule();
    let done = 0;
    let queued = 0;
    for (const trigger of triggers) {
      const minutes = Math.max(1, Number(trigger.apply_when_data?.after_minutes ?? 0) || 0);
      const waiting: { deal_id: number; event_id: number; asked_at: Date }[] = await this.dataSource.query(
        `SELECT d.id AS deal_id, q.id AS event_id, q.created_at AS asked_at
           FROM deal d
           JOIN LATERAL (
             SELECT e.id, e.created_at FROM event e
              WHERE e.deal_id = d.id AND ${clientMessageSql('e', '$2')}
                AND e.created_at > COALESCE((SELECT MAX(o.created_at) FROM event o
                                              WHERE o.deal_id = d.id AND ${answerSql('o', '$3')}), '-infinity')
              ORDER BY e.created_at, e.id LIMIT 1
           ) q ON TRUE
          WHERE d.stage_id = $1 AND d.deleted_at IS NULL AND d.closed_at IS NULL
            AND q.created_at > now() - interval '3 days'
            AND NOT EXISTS (SELECT 1 FROM trigger_run r WHERE r.trigger_id = $4 AND r.deal_id = d.id AND r.run_key = 'noreply:' || q.id)`,
        [trigger.deal_stage.id, CHAT_TYPES, ANSWER_TYPES, trigger.id],
      );
      for (const w of waiting) {
        if (schedule.seconds(new Date(w.asked_at), now) < minutes * 60) continue;
        const deal = await this.dealRepository.findOne({
          where: { id: Number(w.deal_id) },
          relations: { stage: true, created_by: true, agent: true },
        });
        if (!deal || deal.stage?.id !== trigger.deal_stage.id) continue;
        if (await this.actions.precheck(deal, trigger)) continue;
        const blocked = await this.repeatBlock(trigger, deal.id);
        if (blocked) {
          if (blocked.limit) await this.recordLimitOnce(trigger.id, deal.id, blocked.reason);
          continue;
        }
        const key = `noreply:${w.event_id}`;
        if (trigger.type === TriggerTypes.SEND_EMAIL) {
          if (await this.planRun(trigger, deal, now, key)) queued++;
          continue;
        }
        const outcome = await this.executeRecorded(deal.created_by ?? deal.agent ?? null, deal, trigger, NO_CHAIN, key);
        if (outcome?.status === 'done') done++;
      }
    }
    if (queued) this.executeQueuedSoon();
    return done;
  }

  /**
   * Scheduler: executes the runs whose time has come; the result stays in the row.
   * Each row is taken by one UPDATE (pending -> running): a second tick, POST /triggers/run-due
   * at the same moment or another API process skips it. A row left `running` by a restart is
   * failed after RUNNING_STALE_MINUTES (not executed again: a letter or a copy is not repeated).
   */
  async executeDueRuns(limit = 200): Promise<{ executed: number; failed: number; skipped: number }> {
    await this.failCutOffRuns();
    const due = await this.runRepository.find({
      where: { status: TriggerRunStatus.PENDING, run_at: LessThanOrEqual(new Date()) },
      relations: { trigger: { deal_stage: true, target_user: true }, deal: { stage: true, created_by: true, agent: true } },
      order: { run_at: 'ASC', id: 'ASC' },
      take: limit,
    });
    const outcome = { executed: 0, failed: 0, skipped: 0 };
    for (const run of due) {
      if (!(await this.claim(run.id))) continue;
      const trigger = run.trigger;
      const deal = run.deal;
      const now = new Date();
      if (!trigger || !deal || deal.deleted_at || deal.stage?.id !== trigger.deal_stage?.id) {
        await this.finishRun(run.id, TriggerRunStatus.SKIPPED, LEFT_STAGE);
        outcome.skipped++;
        continue;
      }
      const kind = TriggerService.kindOf(trigger);
      if (now.getTime() - run.run_at.getTime() > MISSED_AFTER_MINUTES * 60 * 1000) {
        // the API was not running at that time: a task "after 10 minutes" two days late only confuses
        await this.finishRun(run.id, TriggerRunStatus.SKIPPED, `не выполнен вовремя: опоздание больше ${MISSED_AFTER_MINUTES} мин (API не работал)`);
        outcome.skipped++;
      } else {
        const blocked = await this.repeatBlock(trigger, deal.id, run.id);
        if (blocked) {
          await this.finishRun(run.id, TriggerRunStatus.SKIPPED, blocked.reason);
          outcome.skipped++;
        } else {
          const originatedBy = deal.created_by ?? deal.agent ?? null;
          try {
            const result = await this.executeTrigger(originatedBy, deal, trigger, NO_CHAIN);
            await this.finishWith(run.id, result);
            if (result.status === 'done') outcome.executed++;
            else outcome.skipped++;
          } catch (error) {
            const message = (error as Error).message;
            await this.finishRun(run.id, TriggerRunStatus.FAILED, message);
            outcome.failed++;
            this.loggerService.error(`trigger ${trigger.id} failed for deal ${deal.id}`, (error as Error).stack);
            this.logger.warn(`trigger ${trigger.id} failed for deal ${deal.id}: ${message}`);
            await this.reportFailure(trigger, deal, message);
          }
        }
      }
      if (kind === 'recurring' && !deal.closed_at) {
        const next = TriggerService.nextOccurrence(trigger, now);
        if (next) await this.planRun(trigger, deal, next, TriggerService.runKey('at', next));
      }
    }
    return outcome;
  }

  /** Takes a due row for this execution; false = somebody else took it. */
  private async claim(runId: number): Promise<boolean> {
    const result = await this.dataSource.query(
      `UPDATE trigger_run SET status = $2, executed_at = $3 WHERE id = $1 AND status = $4`,
      [runId, TriggerRunStatus.RUNNING, new Date(), TriggerRunStatus.PENDING],
    );
    return affected(result) === 1;
  }

  private async failCutOffRuns(): Promise<void> {
    const result = await this.dataSource.query(
      `UPDATE trigger_run SET status = $1, error = $2 WHERE status = $3 AND executed_at < $4`,
      [TriggerRunStatus.FAILED, CUT_OFF, TriggerRunStatus.RUNNING, new Date(Date.now() - RUNNING_STALE_MINUTES * 60_000)],
    );
    const n = affected(result);
    if (n) this.logger.warn(`${n} trigger run(s) were cut off by a restart: marked failed`);
  }

  /**
   * Done and failed rows older than TRIGGER_RUNS_KEEP_DAYS (90) go, skipped ones older than
   * TRIGGER_SKIPPED_KEEP_DAYS (30); the last done run of each trigger and deal stays ("only once").
   */
  private async cleanupOldRuns(): Promise<void> {
    if (Date.now() - this.lastCleanup < 6 * 3_600_000) return;
    this.lastCleanup = Date.now();
    try {
      const result = await this.dataSource.query(
        `DELETE FROM trigger_run r
          WHERE ((r.status IN ($1, $3) AND r.created_at < $4) OR (r.status = $2 AND r.created_at < $5))
            AND NOT (r.status = $1 AND r.id = (SELECT MAX(x.id) FROM trigger_run x
                                                WHERE x.trigger_id = r.trigger_id AND x.deal_id = r.deal_id AND x.status = $1))`,
        [
          TriggerRunStatus.DONE,
          TriggerRunStatus.SKIPPED,
          TriggerRunStatus.FAILED,
          new Date(Date.now() - KEEP_RUNS_DAYS * 86_400_000),
          new Date(Date.now() - KEEP_SKIPPED_DAYS * 86_400_000),
        ],
      );
      const n = affected(result);
      if (n) this.logger.log(`trigger history: ${n} old run(s) removed (kept: ${KEEP_RUNS_DAYS} days, skipped ${KEEP_SKIPPED_DAYS})`);
    } catch (error) {
      this.logger.warn(`trigger history cleanup: ${(error as Error).message}`);
    }
  }

  private async finishRun(runId: number, status: TriggerRunStatus, error: string = null, note: string = null): Promise<void> {
    await this.runRepository.update(runId, {
      status,
      executed_at: new Date(),
      error: error ? error.slice(0, 2000) : null,
      note: note ? note.slice(0, 2000) : null,
    });
  }

  private async finishWith(runId: number, result: TriggerOutcome): Promise<void> {
    if (result.status === 'done') await this.finishRun(runId, TriggerRunStatus.DONE, null, result.note ?? null);
    else await this.finishRun(runId, TriggerRunStatus.SKIPPED, result.note || NOT_FITTING);
  }

  /**
   * A failed run is heard of: the admins in the bot (BotWaitingService, TRIGGER_RUN_FAILED) and the
   * people of the deal in its history («Автоматика не сработала …», once a day per trigger and deal),
   * so that a letter that did not go out is not taken for sent.
   */
  private async reportFailure(trigger: Trigger, deal: Deal, error: string): Promise<void> {
    const reason = humanError(error).slice(0, 500);
    const action = ACTION_NAMES[trigger.type] ?? 'действие';
    const payload: TriggerRunFailure = {
      trigger_id: trigger.id,
      trigger_type: trigger.type,
      action,
      stage_id: trigger.deal_stage?.id ?? null,
      stage_name: trigger.deal_stage?.name ?? null,
      deal_id: deal.id,
      deal_display_id: deal.display_id ?? null,
      deal_label: deal.label ?? null,
      error: reason,
    };
    try {
      this.eventEmitter.emit(TRIGGER_RUN_FAILED, payload);
    } catch (e) {
      this.logger.warn(`cannot report the failure of trigger ${trigger.id}: ${(e as Error).message}`);
    }
    try {
      // this failure is a row already: another one within a day means the deal was told; a recurring
      // trigger that keeps failing tells it once, until it works again (not a note every day)
      const [row] = await this.dataSource.query(
        `SELECT COUNT(*) FILTER (WHERE r.executed_at > $4)::int AS day,
                COUNT(*) FILTER (WHERE r.id > COALESCE((SELECT MAX(x.id) FROM trigger_run x
                                                         WHERE x.trigger_id = $1 AND x.deal_id = $2 AND x.status = $5), 0))::int AS streak
           FROM trigger_run r
          WHERE r.trigger_id = $1 AND r.deal_id = $2 AND r.status = $3`,
        [trigger.id, deal.id, TriggerRunStatus.FAILED, new Date(Date.now() - 86_400_000), TriggerRunStatus.DONE],
      );
      if (Number(row?.day ?? 0) > 1) return;
      if (TriggerService.kindOf(trigger) === 'recurring' && Number(row?.streak ?? 0) > 1) return;
      const stage = trigger.deal_stage?.name;
      await this.actions.noteInDeal(
        deal.id,
        `Автоматика не сработала: «${action}»${stage ? ` (триггер этапа «${stage}»)` : ''} — ${reason}`,
        { trigger_id: trigger.id },
      );
    } catch (e) {
      this.logger.warn(`cannot note the failure of trigger ${trigger.id} in deal ${deal.id}: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ execution

  /**
   * Executes now and leaves a done / skipped / failed row in trigger_run; never throws. With a `key`
   * (this entry into the stage, this message) the row is unique: a second execution of the same thing
   * (two requests or two API processes at once) cannot insert it and does nothing.
   */
  private async executeRecorded(
    originatedBy: User,
    deal: Deal,
    trigger: Trigger,
    chain: TriggerChain = NO_CHAIN,
    key: string | null = null,
  ): Promise<TriggerOutcome | null> {
    let runId: number | null = null;
    try {
      const now = new Date();
      const rows: { id: number }[] = await this.dataSource.query(
        `INSERT INTO trigger_run (trigger_id, deal_id, run_at, status, executed_at, run_key) VALUES ($1, $2, $3, $4, $3, $5)
         ON CONFLICT DO NOTHING RETURNING id`,
        [trigger.id, deal.id, now, TriggerRunStatus.RUNNING, key],
      );
      runId = rows?.[0]?.id ?? null;
      if (!runId && key) {
        this.logger.debug(`trigger ${trigger.id} for deal ${deal.id}: ${key} is executed already`);
        return null;
      }
    } catch (error) {
      this.logger.warn(`cannot record a run of trigger ${trigger.id}: ${(error as Error).message}`);
    }
    try {
      const result = await this.executeTrigger(originatedBy, deal, trigger, chain);
      if (runId) await this.finishWith(runId, result);
      return result;
    } catch (error) {
      const message = (error as Error).message;
      if (runId) await this.finishRun(runId, TriggerRunStatus.FAILED, message);
      this.loggerService.error(`trigger ${trigger.id} failed for deal ${deal.id}`, (error as Error).stack);
      this.logger.warn(`trigger ${trigger.id} (${trigger.type}) failed for deal ${deal.id}: ${message}`);
      await this.reportFailure(trigger, deal, message);
      return null;
    }
  }

  /**
   * Executes one trigger for one deal now (TriggerActionsService). Throws on failure (the caller records it).
   * A deal made by a "create deal" trigger or moved by «Перевести в этап» enters its stage here (`chain` one step further).
   * Runs inside `acting`: the events the action causes do not fire event triggers.
   * The journal (src/audit) writes what it changes as the trigger's, not as a person's (AUDIT-11, TRG-5).
   */
  async executeTrigger(
    originatedBy: User,
    deal: Deal,
    trigger: Trigger,
    chain: TriggerChain = NO_CHAIN,
  ): Promise<TriggerOutcome> {
    return AuditJournal.trigger(this.dataSource, trigger.id, deal.id, () =>
      TriggerService.acting.run({ trigger_id: trigger.id, deal_id: deal.id }, () =>
        this.actions.executeTrigger(
          originatedBy,
          deal,
          trigger,
          chain,
          (by, next, stage, further) =>
            this.onDealEnteredStage(by, next, stage, further),
        ),
      ),
    );
  }
}
