import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Trigger, TriggerTypes } from './trigger.entity';
import { TriggerRun, TriggerRunStatus } from './trigger-run.entity';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import { Deal } from '../deal/deal.entity';
import { EventTypes } from '../events/event.entity';
import { RoleEnum, User } from '../user/user.entity';
import { OnEvent } from '@nestjs/event-emitter';
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
import { EmailEventDto } from '../events/dto/email.event.dto';
import { CallRecordingEventDto } from '../events/dto/call.recording.event.dto';
import { TriggerActionsService } from './trigger-actions.service';

export type TriggerKind = 'immediate' | 'delayed' | 'recurring' | 'event';

export interface DealEventContext {
  outgoing?: boolean;
  from_user_id?: number;
}

const EVENT_WHENS = [
  ApplyTriggerWhenEnum.EMAIL_RECEIVED,
  ApplyTriggerWhenEnum.TG_MESSAGE_RECEIVED,
  ApplyTriggerWhenEnum.CALL_RECORDED,
];
const RECURRING_WHENS = [
  ApplyTriggerWhenEnum.EVERY_DAY,
  ApplyTriggerWhenEnum.EVERY_WEEK,
  ApplyTriggerWhenEnum.EVERY_MONTH,
  ApplyTriggerWhenEnum.EVERY_YEAR,
];
// a run that waited longer than this (the API was down) is skipped, not executed late
const MISSED_AFTER_MINUTES = Math.max(1, Number(process.env.TRIGGER_MISSED_AFTER_MINUTES || 24 * 60));
const DEAL_COLUMNS_A_TRIGGER_MAY_CHANGE = ['label', 'budget', 'agent_id'];

/**
 * Triggers of the funnel stages.
 *
 * When they fire (`kindOf`):
 *  - immediate: right after the deal is created in / moved to the stage;
 *  - delayed: N minutes after that, or at an exact date and time;
 *  - recurring: every day / week / month / year while the deal stays in the stage;
 *  - event: when a Telegram message or an email of the deal arrives (`onDealEvent`).
 * Delayed and recurring executions are rows of `trigger_run` (the schedule lives
 * in the database); TriggerScheduler executes the due rows. Every execution is
 * caught and logged: a broken trigger is a failed run, never a crash of the API.
 * What a trigger does to the deal is TriggerActionsService's.
 */
@Injectable()
export class TriggerService {
  private readonly logger = new Logger(TriggerService.name);

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
  ) {}

  // ------------------------------------------------------------------ CRUD

  async fetchAll(stageId: number): Promise<any> {
    const stage = await this.helperService.getById(DealStage, stageId, [
      'triggers',
    ]);

    return stage.triggers
      .sort((a, b) => a.id - b.id)
      .map((trigger) => this.modifyDataAttribute(trigger));
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

    return this.modifyDataAttribute(trigger);
  }

  /** The schedule and the history of a trigger: planned, done and failed runs, newest first. */
  async fetchRuns(stageId: number, triggerId: number, limit = 100): Promise<any[]> {
    await this.fetchOne(stageId, triggerId);
    const runs = await this.runRepository.find({
      where: { trigger: { id: triggerId } },
      relations: { deal: true },
      order: { run_at: 'DESC', id: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
    return runs.map((run) => ({
      id: run.id,
      deal_id: run.deal?.id ?? null,
      deal_label: run.deal?.label ?? null,
      deal: run.deal ? { id: run.deal.id, label: run.deal.label } : null,
      run_at: run.run_at,
      status: run.status,
      executed_at: run.executed_at,
      error: run.error,
    }));
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
      throw new BadRequestException(`Time should be in HH:MM format`);
    }
    if (
      data.apply_when.when === ApplyTriggerWhenEnum.RIGHT_AWAY &&
      (data.apply_when.after_minutes ?? 0) < 0
    ) {
      throw new BadRequestException('after_minutes cannot be negative');
    }

    await this.throwIfInvalidDealFiltersProvided(data.deal_filters ?? []);

    if (data.type === TriggerTypes.CHANGE_FIELDS) {
      await this.throwIfInvalidDealFiltersProvided(data.change_fields_data.fields);
      const readOnly = (data.change_fields_data.fields ?? [])
        .filter((f) => !f.is_filler && !DEAL_COLUMNS_A_TRIGGER_MAY_CHANGE.includes(f.field))
        .map((f) => f.field);
      if (readOnly.length) {
        throw new BadRequestException(
          `A trigger may change only ${DEAL_COLUMNS_A_TRIGGER_MAY_CHANGE.join(', ')} and custom fields, not: ${readOnly.join(', ')}`,
        );
      }
    }
    if (data.type === TriggerTypes.SEND_EMAIL) {
      await this.helperService.getById(EmailTemplate, data.send_email_data.template_id);
      if (data.send_email_data.send_to_user_id) {
        await this.helperService.getById(User, data.send_email_data.send_to_user_id);
      }
    }
    if (data.type === TriggerTypes.CREATE_DEAL) {
      if (Number(data.create_deal_data?.stage_id) === Number(dealStageId)) {
        throw new BadRequestException(
          'A "create deal" trigger cannot create the deal in its own stage',
        );
      }
      await this.helperService.getById(DealStage, data.create_deal_data.stage_id);
    }
    if (data.type === TriggerTypes.CREATE_TASK) {
      await this.helperService.getById(TaskType, data.create_task_data.type_id);
      if (data.create_task_data.responsible?.exact_user_id) {
        await this.helperService.getById(User, data.create_task_data.responsible.exact_user_id);
      }
    }
    if (data.type === TriggerTypes.CHANGE_AGENT) {
      const agent = await this.helperService.getById(User, data.change_agent_data.agent_id);
      if (agent.role === RoleEnum.CTR_AGENT) {
        throw new BadRequestException('The new responsible must be a staff user');
      }
    }

    if (!triggerEntity) {
      triggerEntity = new Trigger();
    }

    triggerEntity.deal_stage = await this.helperService.getById(DealStage, dealStageId);
    triggerEntity.type = data.type;
    triggerEntity.data = data[this.getTargetDataAttributeName(data.type)];
    triggerEntity.deal_filters = (data.deal_filters ?? []).map((f) => ({
      field: f.field,
      value: f.value,
      is_filler: f.is_filler,
    })) as DealFilter[];
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

    const isUpdate = !!triggerEntity.id;
    const saved = await this.triggerRepository.save(triggerEntity);
    if (isUpdate) {
      // the schedule of the old version is void
      await this.runRepository.delete({ trigger: { id: saved.id }, status: TriggerRunStatus.PENDING });
    }
    // the same shape as GET: <type>_data instead of data, plus kind
    return this.modifyDataAttribute(saved);
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

  async throwIfInvalidDealFiltersProvided(dealFilters: DealFilter[]): Promise<void> {
    const availableFilters = await this.helperService.getDealColumns();
    const invalidFilters = [];

    for (const dealFilter of dealFilters ?? []) {
      const found = availableFilters.some(
        (available) =>
          dealFilter.field === available.field &&
          !!dealFilter.is_filler === available.is_filler,
      );
      if (!found) {
        invalidFilters.push(dealFilter.field);
      }
    }

    if (invalidFilters.length !== 0) {
      throw new BadRequestException(
        `Provided invalid deal filters: ${invalidFilters.join(', ')}`,
      );
    }
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
      default:
        throw new BadRequestException(`Provided invalid trigger type`);
    }
  }

  // ------------------------------------------------------------------ when

  static kindOf(trigger: Pick<Trigger, 'apply_when' | 'apply_when_data'>): TriggerKind {
    const when = trigger.apply_when;
    if (EVENT_WHENS.includes(when)) return 'event';
    if (RECURRING_WHENS.includes(when)) return 'recurring';
    if (when === ApplyTriggerWhenEnum.EXACT_TIME) return 'delayed';
    if (Number(trigger.apply_when_data?.after_minutes ?? 0) > 0) return 'delayed';
    return 'immediate';
  }

  private static parseTime(time?: string): [number, number] {
    const [h, m] = String(time || '00:00').split(':').map(Number);
    return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0];
  }

  /** When a delayed trigger fires for a deal that entered the stage at `enteredAt`; null = never (time passed). */
  static delayedRunAt(trigger: Trigger, enteredAt: Date): Date | null {
    const data = trigger.apply_when_data ?? ({} as any);
    if (trigger.apply_when === ApplyTriggerWhenEnum.EXACT_TIME) {
      const date = new Date(data.date);
      if (isNaN(date.getTime())) return null;
      const [h, m] = TriggerService.parseTime(data.time);
      date.setHours(h, m, 0, 0);
      // a date in the past is planned too: the scheduler skips it as missed, which is visible in the runs
      return date;
    }
    const runAt = new Date(enteredAt);
    runAt.setMinutes(runAt.getMinutes() + Number(data.after_minutes ?? 0));
    runAt.setSeconds(0, 0);
    return runAt;
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
   * The deal was created in or moved to `stage`: immediate triggers run now,
   * delayed and recurring ones are planned; pending runs of other stages are cancelled.
   */
  async onDealEnteredStage(
    originatedBy: User,
    deal: Deal,
    stage: DealStage,
    depth = 0,
  ): Promise<void> {
    if (!stage) return;
    try {
      await this.cancelRunsOfOtherStages(deal.id, stage.id);
      const triggers = await this.triggersOfStage(stage.id);
      const now = new Date();
      for (const trigger of triggers) {
        const kind = TriggerService.kindOf(trigger);
        if (kind === 'immediate') {
          await this.executeRecorded(originatedBy, deal, trigger, depth);
        } else if (kind === 'delayed') {
          const runAt = TriggerService.delayedRunAt(trigger, now);
          if (runAt) await this.planRun(trigger, deal, runAt);
        } else if (kind === 'recurring') {
          const runAt = TriggerService.nextOccurrence(trigger, now);
          if (runAt) await this.planRun(trigger, deal, runAt);
        }
      }
    } catch (error) {
      this.loggerService.error(`triggers of stage ${stage.id} for deal ${deal.id}`, (error as Error).stack);
      this.logger.error(`triggers of stage ${stage.id} for deal ${deal.id}: ${(error as Error).message}`);
    }
  }

  /** Kept for the old callers: immediate triggers of a stage. */
  async handleTriggers(originatedBy: User, deal: Deal, triggers: Trigger[] = []): Promise<void> {
    for (const trigger of triggers) {
      if (TriggerService.kindOf(trigger) === 'immediate') {
        await this.executeRecorded(originatedBy, deal, trigger);
      }
    }
  }

  /** A call recording was linked to a deal: the "записан звонок" triggers of its stage. */
  @OnEvent(EventTypes.NEW_CALL_RECORDING.toString())
  async onCallRecorded(data: CallRecordingEventDto): Promise<void> {
    if (!data?.deal?.id || data.history) return;
    try {
      await this.onDealEvent(data.target_user ?? data.originated_by, data.deal, ApplyTriggerWhenEnum.CALL_RECORDED, {
        outgoing: data.recording?.outgoing,
        from_user_id: data.originated_by?.id,
      });
    } catch (error) {
      this.logger.warn(`call triggers of deal ${data.deal.id}: ${(error as Error).message}`);
    }
  }

  /** An email arrived or was sent in a deal: the "при письме" triggers of its stage. */
  @OnEvent(EventTypes.NEW_EMAIL.toString())
  async onEmailEvent(data: EmailEventDto[] | EmailEventDto): Promise<void> {
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item?.deal?.id) continue;
      try {
        await this.onDealEvent(item.originated_by, item.deal, ApplyTriggerWhenEnum.EMAIL_RECEIVED, {
          outgoing: item.email?.outgoing,
          from_user_id: item.email?.from_user?.id,
        });
      } catch (error) {
        this.logger.warn(`email triggers of deal ${item.deal.id}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Something happened in the deal (a Telegram message, an email, a call):
   * the triggers of its current stage that wait for this event run.
   */
  async onDealEvent(
    originatedBy: User,
    deal: Deal,
    when: ApplyTriggerWhenEnum,
    context: DealEventContext = {},
  ): Promise<number> {
    const stageId = deal.stage?.id ?? (await this.stageIdOf(deal.id));
    if (!stageId) return 0;
    const triggers = (await this.triggersOfStage(stageId)).filter((t) => t.apply_when === when);
    let fired = 0;
    for (const trigger of triggers) {
      const data = trigger.apply_when_data ?? ({} as any);
      if (typeof data.outgoing === 'boolean' && context.outgoing !== undefined && data.outgoing !== context.outgoing) {
        continue;
      }
      if (data.from_user_id && Number(data.from_user_id) !== Number(context.from_user_id)) {
        continue;
      }
      await this.executeRecorded(originatedBy, deal, trigger);
      fired++;
    }
    return fired;
  }

  // ------------------------------------------------------------------ schedule

  private async triggersOfStage(stageId: number): Promise<Trigger[]> {
    return this.triggerRepository.find({
      where: { deal_stage: { id: stageId } },
      relations: { deal_stage: true, target_user: true },
      order: { id: 'ASC' },
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
      [TriggerRunStatus.SKIPPED, dealId, TriggerRunStatus.PENDING, stageId, 'the deal left the stage'],
    );
  }

  /** One pending run per trigger and deal. */
  async planRun(trigger: Trigger, deal: Deal, runAt: Date): Promise<TriggerRun | null> {
    const pending = await this.runRepository.findOne({
      where: { trigger: { id: trigger.id }, deal: { id: deal.id }, status: TriggerRunStatus.PENDING },
    });
    if (pending) return null;
    const run = new TriggerRun();
    run.trigger = trigger;
    run.deal = deal;
    run.run_at = runAt;
    run.status = TriggerRunStatus.PENDING;
    return this.runRepository.save(run);
  }

  /**
   * Scheduler: delayed runs that are missing. A deal in the stage without any run of the
   * trigger (it got there past the API, or the API was down at that moment) is planned from
   * the moment it entered the stage (last_stage_change, else created_at). Deals that entered
   * before the trigger was created are left alone: the trigger did not exist for them.
   */
  async planMissingDelayedRuns(): Promise<number> {
    const triggers = await this.triggerRepository
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.deal_stage', 's')
      .leftJoin('s.collection', 'c')
      .where('c.is_active = true')
      .getMany();
    let planned = 0;
    for (const trigger of triggers.filter((t) => TriggerService.kindOf(t) === 'delayed')) {
      const deals = await this.dealRepository
        .createQueryBuilder('d')
        .where('d.stage_id = :stage', { stage: trigger.deal_stage.id })
        .andWhere('d.closed_at IS NULL')
        .andWhere('d.deleted_at IS NULL')
        // "after N minutes" is about entering the stage, so deals that entered before the trigger
        // existed are left alone; "at an exact time" is for every deal that is in the stage then
        // all timestamps are in one zone (migration 1794960000000-time-zone), compared as they are
        .andWhere(
          trigger.apply_when === ApplyTriggerWhenEnum.EXACT_TIME
            ? '1 = 1'
            : `COALESCE(d.last_stage_change, d.created_at) >= (SELECT t.created_at FROM "trigger" t WHERE t.id = :trigger)`,
          { trigger: trigger.id },
        )
        .andWhere('NOT EXISTS (SELECT 1 FROM trigger_run r WHERE r.trigger_id = :trigger AND r.deal_id = d.id)', { trigger: trigger.id })
        .getMany();
      for (const deal of deals) {
        const runAt = TriggerService.delayedRunAt(trigger, deal.last_stage_change ?? deal.created_at ?? new Date());
        if (runAt && (await this.planRun(trigger, deal, runAt))) planned++;
      }
    }
    return planned;
  }

  /** Scheduler: every open deal in a stage with recurring triggers has its next run planned. */
  async planRecurringRuns(): Promise<number> {
    const triggers = await this.triggerRepository
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.deal_stage', 's')
      .leftJoin('s.collection', 'c')
      .where('t.apply_when IN (:...whens)', { whens: RECURRING_WHENS })
      .andWhere('c.is_active = true')
      .getMany();
    let planned = 0;
    const now = new Date();
    for (const trigger of triggers) {
      const deals = await this.dealRepository
        .createQueryBuilder('d')
        .where('d.stage_id = :stage', { stage: trigger.deal_stage.id })
        .andWhere('d.closed_at IS NULL')
        .andWhere('d.deleted_at IS NULL')
        .getMany();
      for (const deal of deals) {
        const runAt = TriggerService.nextOccurrence(trigger, now);
        if (runAt && (await this.planRun(trigger, deal, runAt))) planned++;
      }
    }
    return planned;
  }

  /** One tick of the schedule by hand (POST /triggers/run-due) or from the scheduler. */
  async runDue(): Promise<{ planned: number; executed: number; failed: number; skipped: number }> {
    const planned = (await this.planMissingDelayedRuns()) + (await this.planRecurringRuns());
    const outcome = await this.executeDueRuns();
    return { planned, ...outcome };
  }

  /** Scheduler: executes the runs whose time has come; the result stays in the row. */
  async executeDueRuns(limit = 200): Promise<{ executed: number; failed: number; skipped: number }> {
    const due = await this.runRepository.find({
      where: { status: TriggerRunStatus.PENDING, run_at: LessThanOrEqual(new Date()) },
      relations: { trigger: { deal_stage: true, target_user: true }, deal: { stage: true, created_by: true, agent: true } },
      order: { run_at: 'ASC', id: 'ASC' },
      take: limit,
    });
    const outcome = { executed: 0, failed: 0, skipped: 0 };
    for (const run of due) {
      const trigger = run.trigger;
      const deal = run.deal;
      const now = new Date();
      if (!trigger || !deal || deal.deleted_at || deal.stage?.id !== trigger.deal_stage?.id) {
        await this.finishRun(run, TriggerRunStatus.SKIPPED, 'the deal left the stage');
        outcome.skipped++;
        continue;
      }
      const kind = TriggerService.kindOf(trigger);
      if (now.getTime() - run.run_at.getTime() > MISSED_AFTER_MINUTES * 60 * 1000) {
        // the API was not running at that time: a task "after 10 minutes" two days late only confuses
        await this.finishRun(run, TriggerRunStatus.SKIPPED, `missed by more than ${MISSED_AFTER_MINUTES} minutes`);
        outcome.skipped++;
      } else {
        const originatedBy = deal.created_by ?? deal.agent ?? null;
        try {
          await this.executeTrigger(originatedBy, deal, trigger);
          await this.finishRun(run, TriggerRunStatus.DONE);
          outcome.executed++;
        } catch (error) {
          await this.finishRun(run, TriggerRunStatus.FAILED, (error as Error).message);
          outcome.failed++;
          this.loggerService.error(`trigger ${trigger.id} failed for deal ${deal.id}`, (error as Error).stack);
          this.logger.warn(`trigger ${trigger.id} failed for deal ${deal.id}: ${(error as Error).message}`);
        }
      }
      if (kind === 'recurring' && !deal.closed_at) {
        const next = TriggerService.nextOccurrence(trigger, now);
        if (next) await this.planRun(trigger, deal, next);
      }
    }
    return outcome;
  }

  private async finishRun(run: TriggerRun, status: TriggerRunStatus, error: string = null): Promise<void> {
    await this.runRepository.update(run.id, {
      status,
      executed_at: new Date(),
      error: error ? error.slice(0, 2000) : null,
    });
  }

  // ------------------------------------------------------------------ execution

  /** Executes now and leaves a done / failed row in trigger_run; never throws. */
  private async executeRecorded(originatedBy: User, deal: Deal, trigger: Trigger, depth = 0): Promise<void> {
    const run = new TriggerRun();
    run.trigger = trigger;
    run.deal = deal;
    run.run_at = new Date();
    run.status = TriggerRunStatus.PENDING;
    let saved: TriggerRun | null = null;
    try {
      saved = await this.runRepository.save(run);
    } catch (error) {
      this.logger.warn(`cannot record a run of trigger ${trigger.id}: ${(error as Error).message}`);
    }
    try {
      await this.executeTrigger(originatedBy, deal, trigger, depth);
      if (saved) await this.finishRun(saved, TriggerRunStatus.DONE);
    } catch (error) {
      if (saved) await this.finishRun(saved, TriggerRunStatus.FAILED, (error as Error).message);
      this.loggerService.error(`trigger ${trigger.id} failed for deal ${deal.id}`, (error as Error).stack);
      this.logger.warn(`trigger ${trigger.id} (${trigger.type}) failed for deal ${deal.id}: ${(error as Error).message}`);
    }
  }

  /**
   * Executes one trigger for one deal now (TriggerActionsService). Throws on failure (the caller records it).
   * A deal made by a "create deal" trigger enters its stage here, one level deeper.
   */
  async executeTrigger(
    originatedBy: User,
    deal: Deal,
    trigger: Trigger,
    depth = 0,
  ): Promise<void> {
    await this.actions.executeTrigger(
      originatedBy,
      deal,
      trigger,
      depth,
      (by, copy, stage, level) =>
        this.onDealEnteredStage(by, copy, stage, level),
    );
  }
}
