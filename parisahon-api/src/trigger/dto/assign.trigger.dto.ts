import { TriggerTypes } from '../trigger.entity';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// region Create Task trigger

export enum TaskResponsibleEnum {
  CURRENT_ASSIGNED = 'currently_assigned',
  CREATOR = 'creator',
}

export class TaskResponsible {
  @IsNumber()
  @ValidateIf((o) => o.user === undefined)
  exact_user_id: number;

  @IsEnum(TaskResponsibleEnum)
  @ValidateIf((o) => o.exact_user_id === undefined)
  user: TaskResponsibleEnum;
}

export class CreateTaskContents {
  @IsString()
  label: string;

  @IsNumber()
  type_id: number;

  @ValidateNested()
  @IsObject()
  @Type(() => TaskResponsible)
  responsible: TaskResponsible;

  // minutes from the event; a whole number of days means the end of that working day
  // (see TriggerActionsService.taskDeadline), 0 = at the moment of the event
  @IsNumber()
  end_time_in_minutes: number;

  @IsBoolean()
  all_day: boolean;

  // «Конец дня»: the end of today's working day (CONTROL_WORK_HOURS), end_time_in_minutes is ignored
  @IsOptional()
  @IsIn(['end_of_working_day'])
  deadline?: 'end_of_working_day';
}

// endregion

// region Send Email trigger

export class SendEmailContents {
  // a chosen recipient; without it the letter goes to the contacts of the deal
  @IsOptional()
  @IsNumber()
  send_to_user_id: number;

  @IsNumber()
  template_id: number;

  // who the letter is from: the responsible of the deal (default) or its creator
  @IsOptional()
  @IsEnum(TaskResponsibleEnum)
  from: TaskResponsibleEnum;

  // true: always from the shared mailbox of the company; not set: from the sender's own connected
  // (checked) mailbox, else the shared one (TriggerActionsService.handleSendEmail)
  @IsOptional()
  @IsBoolean()
  shared_mailbox?: boolean;

  // the deal's files of these extensions go with the letter (["pdf"]: the КП uploaded to the deal),
  // the newest first, at most 5; none in the deal = the run fails visibly (no letter without its file)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  attach_extensions?: string[];
}

// endregion

// region Create Deal trigger

export class CreateDealContents {
  // where the copy of the deal is created (another stage, possibly of another funnel)
  @IsNumber()
  stage_id: number;

  @IsOptional()
  @IsString()
  @Length(0, 255)
  label: string;

  // the copy takes the custom fields and the products of the deal too (not set = yes)
  @IsOptional()
  @IsBoolean()
  copy_fields?: boolean;

  @IsOptional()
  @IsBoolean()
  copy_products?: boolean;
}

// endregion

// region Move Stage trigger

export class MoveStageContents {
  // the stage the deal goes to (of this pipeline or another one)
  @IsNumber()
  stage_id: number;
}

// endregion

// region Notify trigger

export enum NotifyWhomEnum {
  RESPONSIBLE = 'responsible',
  MANAGERS = 'managers',
  BOTH = 'both',
}

export class NotifyContents {
  // the text of the message; {{сделка}}, {{клиент}}, {{менеджер}}, {{сумма}} ... are filled in
  @IsString()
  @Length(1, 1000)
  text: string;

  // the responsible of the deal (default), the managers and admins, or both
  @IsOptional()
  @IsEnum(NotifyWhomEnum)
  to?: NotifyWhomEnum;

  // or one chosen employee
  @IsOptional()
  @IsNumber()
  user_id?: number;
}

// endregion

// region Change Field Contents trigger

export class ChangeFieldContents {
  // DealFilter just happen to have the same fields, reusing
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DealFilter)
  fields: DealFilter[];
}

// endregion

// region Change Agent trigger

export class ChangeAgentContents {
  // the new responsible; not needed when the deals are handed out in turn (rotate_user_ids)
  @ValidateIf((o) => !Array.isArray(o.rotate_user_ids) || o.rotate_user_ids.length === 0)
  @IsNumber()
  agent_id: number;

  // «по очереди»: each deal goes to the next of these employees (round robin over the list)
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  rotate_user_ids?: number[];

  // the open tasks of the deal of the previous responsible go to the new one (not set = yes)
  @IsOptional()
  @IsBoolean()
  transfer_tasks?: boolean;
}

// endregion

// region Close Task trigger

export enum WithTaskEndTimeEnum {
  OVERDUE = 'overdue',
  TODAY = 'today',
  TOMORROW = 'tomorrow',
  ALL = 'all',
}

export class CloseTaskContents {
  @Length(1, 255)
  @IsString()
  result: string;

  // the type of the tasks to close; 0 or not set = tasks of any type
  @IsOptional()
  @IsNumber()
  type_id: number;

  @IsEnum(WithTaskEndTimeEnum, { each: true })
  @IsArray()
  with_task_end_times: WithTaskEndTimeEnum[];
}

// endregion

// region Delete files trigger

export enum WhichFiles {
  FROM_MESSAGES = 'from_messages',
  FROM_EMAILS = 'from_emails',
  UPLOADED_FROM_FILES_TAB = 'uploaded_from_files_tab',
  FROM_COMMENTS = 'from_comments',
  // TODO: Need to add ispolzovannix v polyax option from amocrm, have no idea what that is
}

export class DeleteFilesContents {
  @IsArray()
  @IsString({ each: true })
  with_extensions: string[];

  @IsArray()
  @IsEnum(WhichFiles, { each: true })
  which_files: WhichFiles[];

  @IsOptional()
  @IsNumber()
  @IsPositive()
  from_bytes: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  till_bytes: number;
}

// endregion

// region Assign trigger

// how a condition compares: equal (default), not equal, greater / less (numbers), contains (text)
export const FILTER_OPS = ['eq', 'ne', 'gt', 'lt', 'contains'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

// the channel the deal came from (condition field `source`, see TriggerActionsService.getTargetDeal)
export const DEAL_SOURCES = ['telegram', 'whatsapp', 'email', 'call', 'manual'] as const;

export class DealFilter {
  // a column of the deal (agent_id, budget, label), `source` (the channel the deal came from) or
  // the name of a custom field (is_filler)
  @IsString()
  @Length(1, 255)
  field: string;

  value: string;

  @IsBoolean()
  is_filler: boolean;

  @IsOptional()
  @IsIn(FILTER_OPS as unknown as string[])
  op?: FilterOp;

  // a custom field is kept by its id too (filled in by the API), so renaming the field keeps the trigger
  @IsOptional()
  @IsNumber()
  filler_id?: number;
}

export enum ApplyTriggerWhenEnum {
  RIGHT_AWAY = 'right_away',
  EXACT_TIME = 'at_exact_time',
  EVERY_DAY = 'every_day',
  EVERY_WEEK = 'every_week',
  EVERY_MONTH = 'every_month',
  EVERY_YEAR = 'every_year',
  EMAIL_RECEIVED = 'email_received',
  TG_MESSAGE_RECEIVED = 'tg_message_received',
  WA_MESSAGE_RECEIVED = 'wa_message_received',
  CALL_RECORDED = 'call_recorded',
  // the client wrote and waits for an answer `after_minutes` working minutes (no answer, no call back)
  NO_REPLY = 'no_reply',
}

export class ApplyWhenDto {
  @IsEnum(ApplyTriggerWhenEnum)
  when: ApplyTriggerWhenEnum;

  // right_away: the delay after entering the stage (0 = at once); no_reply: how long the client waits
  @IsNumber()
  @Min(0)
  @Max(525600)
  @ValidateIf((o) => o.when === ApplyTriggerWhenEnum.RIGHT_AWAY || o.when === ApplyTriggerWhenEnum.NO_REPLY)
  after_minutes: number;

  @IsDateString()
  @ValidateIf((o) => o.when === ApplyTriggerWhenEnum.EXACT_TIME)
  date: Date;

  @ValidateIf((o) =>
    [
      ApplyTriggerWhenEnum.EVERY_DAY,
      ApplyTriggerWhenEnum.EVERY_WEEK,
      ApplyTriggerWhenEnum.EVERY_MONTH,
      ApplyTriggerWhenEnum.EVERY_YEAR,
      ApplyTriggerWhenEnum.EXACT_TIME,
    ].includes(o.when),
  )
  @IsString()
  time: string;

  @IsNumber()
  @Min(1)
  @Max(12)
  @ValidateIf((o) => o.when === ApplyTriggerWhenEnum.EVERY_YEAR)
  month: number;

  @IsNumber()
  @Min(1)
  @Max(7)
  @ValidateIf((o) => o.when === ApplyTriggerWhenEnum.EVERY_WEEK)
  week_day: number;

  @IsNumber()
  @Min(1)
  @Max(31)
  @ValidateIf((o) =>
    [
      ApplyTriggerWhenEnum.EVERY_MONTH,
      ApplyTriggerWhenEnum.EVERY_YEAR,
    ].includes(o.when),
  )
  day: number;

  // «сотрудник»: only events of this employee (the sender, the manager of the chat or the call)
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @ValidateIf((o) =>
    [
      ApplyTriggerWhenEnum.EMAIL_RECEIVED,
      ApplyTriggerWhenEnum.TG_MESSAGE_RECEIVED,
      ApplyTriggerWhenEnum.WA_MESSAGE_RECEIVED,
      ApplyTriggerWhenEnum.CALL_RECORDED,
    ].includes(o.when),
  )
  from_user_id: number;

  // the direction of the message or call; not set = any
  @IsOptional()
  @IsBoolean()
  @ValidateIf((o) =>
    [
      ApplyTriggerWhenEnum.EMAIL_RECEIVED,
      ApplyTriggerWhenEnum.TG_MESSAGE_RECEIVED,
      ApplyTriggerWhenEnum.WA_MESSAGE_RECEIVED,
      ApplyTriggerWhenEnum.CALL_RECORDED,
    ].includes(o.when),
  )
  outgoing: boolean;

  // repeats for one deal (not for the recurring ones, they follow their schedule):
  // only once for a deal, ever; not set = only "create deal" (TriggerService.repeatRule)
  @IsOptional()
  @IsBoolean()
  once_per_deal?: boolean;

  // not again for the same deal within this many minutes; 0 = every time;
  // not set = a day for "send email", else 0 (TriggerService.repeatRule)
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(525600)
  cooldown_minutes?: number;
}

/** PATCH /stages/:id/trigger-order: the ids of every trigger of the stage, in the order they run. */
export class TriggerOrderDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  ids: number[];
}

export class AssignTriggerDto {
  // TODO: Something is going wrong when trying to use @IsEnum() here
  @IsIn([0, 1, 2, 3, 4, 5, 6, 7, 8])
  type: TriggerTypes;

  // the order of the triggers of a stage (they run in it, then by id); not set = after the others
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  position?: number;

  @ValidateNested({ each: true })
  @Type(() => DealFilter)
  @IsArray()
  deal_filters: DealFilter[];

  @ValidateNested()
  @IsObject()
  @Type(() => ApplyWhenDto)
  apply_when: ApplyWhenDto;

  @ValidateIf((o) => o.type === TriggerTypes.CREATE_TASK)
  @IsObject()
  @ValidateNested()
  @Type(() => CreateTaskContents)
  create_task_data: CreateTaskContents;

  @ValidateIf((o) => o.type === TriggerTypes.CREATE_DEAL)
  @IsObject()
  @ValidateNested()
  @Type(() => CreateDealContents)
  create_deal_data: CreateDealContents;

  @ValidateIf((o) => o.type === TriggerTypes.DELETE_FILES)
  @IsObject()
  @ValidateNested()
  @Type(() => DeleteFilesContents)
  delete_files_data: DeleteFilesContents;

  @ValidateIf((o) => o.type === TriggerTypes.CHANGE_AGENT)
  @IsObject()
  @ValidateNested()
  @Type(() => ChangeAgentContents)
  change_agent_data: ChangeAgentContents;

  @ValidateIf((o) => o.type === TriggerTypes.CLOSE_TASKS)
  @IsObject()
  @ValidateNested()
  @Type(() => CloseTaskContents)
  close_tasks_data: CloseTaskContents;

  @ValidateIf((o) => o.type === TriggerTypes.CHANGE_FIELDS)
  @IsObject()
  @ValidateNested()
  @Type(() => ChangeFieldContents)
  change_fields_data: ChangeFieldContents;

  @ValidateIf((o) => o.type === TriggerTypes.SEND_EMAIL)
  @IsObject()
  @ValidateNested()
  @Type(() => SendEmailContents)
  send_email_data: SendEmailContents;

  @ValidateIf((o) => o.type === TriggerTypes.MOVE_STAGE)
  @IsObject()
  @ValidateNested()
  @Type(() => MoveStageContents)
  move_stage_data: MoveStageContents;

  @ValidateIf((o) => o.type === TriggerTypes.NOTIFY)
  @IsObject()
  @ValidateNested()
  @Type(() => NotifyContents)
  notify_data: NotifyContents;
}

// endregion
