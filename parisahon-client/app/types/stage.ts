export type StageCollection = {
    id: number;
    name: string;
    is_active: boolean;
    created_at: string;
}

export type Stage = {
    id: number;
    name: string;
    description: string | null;
    order: number;
    created_at: string;
    triggers: StageTrigger[];
    color: string;
    collection_id?: number;
    // GET /stages: a closing stage («успешно реализовано», «закрыто и не реализовано»)
    is_closing?: boolean;
    // what the stage means (the name is only its label): a system stage of every pipeline or `work`
    kind?: StageKind;
    // a system stage: cannot be deleted (can be renamed)
    is_system?: boolean;
}

export type StageKind = 'new' | 'first_contact' | 'prepayment' | 'won' | 'lost' | 'work';

/** What a system stage does, for the hint in «Настроить воронку» */
export const stageKindHints: Record<StageKind, string> = {
    new: 'Системный этап: сюда попадают новые сделки из Telegram, WhatsApp, звонков и почты, если этап для новых сделок не подходит',
    first_contact: 'Системный этап «первичный контакт»',
    prepayment: 'Системный этап «предоплата»',
    won: 'Системный этап: закрывает сделку как успешную — она идёт в план/факт, аналитику и LTV',
    lost: 'Системный этап: закрывает сделку как нереализованную',
    work: '',
};

export type DealFilter = {
    label: string;
    is_filler: boolean;
    // a column (agent_id, budget, label), `source` (the channel the deal came from) or a custom field
    field: string;
    value: string;
    // a custom field: its id (the API fills it in; the name may change)
    filler_id?: number;
    // how a condition compares (not set: equal)
    op?: FilterOp;
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'lt' | 'contains';

export enum TriggerType {
    CreateTask = 0,
    CreateDeal = 1,
    SendEmail = 2,
    CloseTasks = 3,
    ChangeAgent = 4,
    ChangeFields = 5,
    DeleteFiles = 6,
    MoveStage = 7,
    Notify = 8,
}

export enum ApplyWhenType {
    RightAway = 'right_away',
    AtExactTime = 'at_exact_time',
    EveryDay = 'every_day',
    EveryWeek = 'every_week',
    EveryMonth = 'every_month',
    EveryYear = 'every_year',
    TgMessageReceived = 'tg_message_received',
    EmailReceived = 'email_received',
    WaMessageReceived = 'wa_message_received',
    CallRecorded = 'call_recorded',
    // the client waits for an answer N working minutes
    NoReply = 'no_reply',
}

// how often a trigger may act for one deal (not set: the API's default for the action)
export type ApplyWhenRepeat = { once_per_deal?: boolean; cooldown_minutes?: number }

export type ApplyWhen = (
|  {when: `${ApplyWhenType.RightAway}`, after_minutes: number}
|  {when: `${ApplyWhenType.AtExactTime}`, date: string, time: string}
|  {when: `${ApplyWhenType.EveryDay}`, time: string}
|  {when: `${ApplyWhenType.EveryWeek}`, time: string, week_day: number}
|  {when: `${ApplyWhenType.EveryMonth}`, time: string, day: number}
|  {when: `${ApplyWhenType.EveryYear}`, time: string, day: number, month: number}
|  {when: `${ApplyWhenType.TgMessageReceived}`, outgoing?: boolean, from_user_id?: number}
|  {when: `${ApplyWhenType.EmailReceived}`, outgoing?: boolean, from_user_id?: number}
|  {when: `${ApplyWhenType.WaMessageReceived}`, outgoing?: boolean, from_user_id?: number}
|  {when: `${ApplyWhenType.CallRecorded}`, outgoing?: boolean, from_user_id?: number}
|  {when: `${ApplyWhenType.NoReply}`, after_minutes: number}
) & ApplyWhenRepeat

export type BaseTrigger = {
    id: number;
    position: number;
    apply_when: ApplyWhen;
    deal_filters: DealFilter[];
    status?: string; 
}

export type BaseStageTrigger = {
    id: number;
    position: number;
    apply_when_data: ApplyWhen;
    apply_when: `${ApplyWhenType}`;
    deal_filters: DealFilter[];
    is_delayed: boolean;
    is_recurring: boolean;
    status?: string;
    // what the trigger names and is gone (GET /stages/:id/triggers): it cannot work
    problems?: string[];
}

export type ChangeAgentData = {
    agent_id?: number;
    // «по очереди»: each deal goes to the next of these employees (раздача заявок)
    rotate_user_ids?: number[];
    // the open tasks of the previous responsible go to the new one (not set = yes)
    transfer_tasks?: boolean;
}

export type CreateTaskData = {
    label: string;
    type_id: number;
    end_time_in_minutes: number;
    all_day: boolean;
    // «Конец дня»: the end of the working day (end_time_in_minutes is then 0)
    deadline?: 'end_of_working_day';
    responsible: {
        user?: string;
        exact_user_id?: number;
    }
}

export type ChangeFieldsData = {
    fields: DealFilter[];
}

export type CloseTasksData = {
    result: string;
    type_id: number;
    with_task_end_times: string[];
}

export enum FileSource {
    FromMessages = 'from_messages',
    FromEmails = 'from_emails',
    FromFilesTab = 'uploaded_from_files_tab',
    FromComments = 'from_comments'
}

export type DeleteFilesData = {
    with_extensions: string[];
    which_files: FileSource[];
    from_bytes?: number;
    till_bytes?: number;
}

export type SendEmailData = {
    // a chosen recipient; empty = the contacts of the deal
    send_to_user_id?: number | null;
    template_id: number;
    from: 'currently_assigned' | 'creator';
    // true: from the shared mailbox even when the sender has a mailbox of their own
    shared_mailbox?: boolean;
    // the deal's files of these types go with the letter (["pdf"]: the КП uploaded to the deal)
    attach_extensions?: string[];
}

export type CreateDealData = {
    stage_id?: number;
    label?: string;
    // the copy takes the custom fields and the products too (not set = yes)
    copy_fields?: boolean;
    copy_products?: boolean;
}

export type MoveStageData = {
    stage_id?: number;
}

export type NotifyData = {
    text: string;
    to?: 'responsible' | 'managers' | 'both';
    user_id?: number | null;
}

export type TaskTrigger = { type: TriggerType.CreateTask; create_task_data: CreateTaskData }
export type ChangeAgentTrigger = { type: TriggerType.ChangeAgent, change_agent_data: ChangeAgentData }
export type ChangeFieldsTrigger = { type: TriggerType.ChangeFields, change_fields_data: ChangeFieldsData }
export type CloseTasksTrigger = { type: TriggerType.CloseTasks, close_tasks_data: CloseTasksData }
export type DeleteFilesTrigger = { type: TriggerType.DeleteFiles, delete_files_data: DeleteFilesData }
export type SendEmailTrigger = { type: TriggerType.SendEmail, send_email_data: SendEmailData }
export type CreateDealTrigger = { type: TriggerType.CreateDeal, create_deal_data: CreateDealData }
export type MoveStageTrigger = { type: TriggerType.MoveStage, move_stage_data: MoveStageData }
export type NotifyTrigger = { type: TriggerType.Notify, notify_data: NotifyData }

export type StageTaskTrigger = { type: TriggerType.CreateTask; data: CreateTaskData }
export type StageChangeAgentTrigger = { type: TriggerType.ChangeAgent, data: ChangeAgentData }
export type StageChangeFieldsTrigger = { type: TriggerType.ChangeFields, data: ChangeFieldsData }
export type StageCloseTasksTrigger = { type: TriggerType.CloseTasks, data: CloseTasksData }
export type StageDeleteFilesTrigger = { type: TriggerType.DeleteFiles, data: DeleteFilesData }
export type StageSendEmailTrigger = { type: TriggerType.SendEmail, data: SendEmailData }
export type StageCreateDealTrigger = { type: TriggerType.CreateDeal, data: CreateDealData }
export type StageMoveStageTrigger = { type: TriggerType.MoveStage, data: MoveStageData }
export type StageNotifyTrigger = { type: TriggerType.Notify, data: NotifyData }

export type Triggers = 
|  ChangeAgentTrigger
|  TaskTrigger
|  ChangeFieldsTrigger
|  CloseTasksTrigger
|  DeleteFilesTrigger
|  SendEmailTrigger
|  CreateDealTrigger
|  MoveStageTrigger
|  NotifyTrigger

export type Trigger = BaseTrigger & Triggers;

export type StageTriggers =
|  StageTaskTrigger
|  StageChangeAgentTrigger
|  StageChangeFieldsTrigger
|  StageCloseTasksTrigger
|  StageDeleteFilesTrigger
|  StageSendEmailTrigger
|  StageCreateDealTrigger
|  StageMoveStageTrigger
|  StageNotifyTrigger

export type StageTrigger = BaseStageTrigger & StageTriggers;