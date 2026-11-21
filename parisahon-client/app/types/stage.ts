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
}

export type DealFilter = {
    label: string;
    is_filler: boolean;
    field: string;
    value: string;
}

export enum TriggerType {
    CreateTask = 0,
    CreateDeal = 1,
    SendEmail = 2,
    CloseTasks = 3,
    ChangeAgent = 4,
    ChangeFields = 5,
    DeleteFiles = 6,
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
}

export type ApplyWhen =
|  {when: `${ApplyWhenType.RightAway}`, after_minutes: number}
|  {when: `${ApplyWhenType.AtExactTime}`, date: string, time: string}
|  {when: `${ApplyWhenType.EveryDay}`, time: string}
|  {when: `${ApplyWhenType.EveryWeek}`, time: string, week_day: number}
|  {when: `${ApplyWhenType.EveryMonth}`, time: string, day: number}
|  {when: `${ApplyWhenType.EveryYear}`, time: string, day: number, month: number}
|  {when: `${ApplyWhenType.TgMessageReceived}`, outgoing?: boolean}
|  {when: `${ApplyWhenType.EmailReceived}`, outgoing?: boolean}

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
}

export type ChangeAgentData = {
    agent_id: number;
}

export type CreateTaskData = {
    label: string;
    type_id: number;
    end_time_in_minutes: number;
    all_day: boolean;
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
}

export type CreateDealData = {
    stage_id?: number;
    label?: string;
}

export type TaskTrigger = { type: TriggerType.CreateTask; create_task_data: CreateTaskData }
export type ChangeAgentTrigger = { type: TriggerType.ChangeAgent, change_agent_data: ChangeAgentData }
export type ChangeFieldsTrigger = { type: TriggerType.ChangeFields, change_fields_data: ChangeFieldsData }
export type CloseTasksTrigger = { type: TriggerType.CloseTasks, close_tasks_data: CloseTasksData }
export type DeleteFilesTrigger = { type: TriggerType.DeleteFiles, delete_files_data: DeleteFilesData }
export type SendEmailTrigger = { type: TriggerType.SendEmail, send_email_data: SendEmailData }
export type CreateDealTrigger = { type: TriggerType.CreateDeal, create_deal_data: CreateDealData }

export type StageTaskTrigger = { type: TriggerType.CreateTask; data: CreateTaskData }
export type StageChangeAgentTrigger = { type: TriggerType.ChangeAgent, data: ChangeAgentData }
export type StageChangeFieldsTrigger = { type: TriggerType.ChangeFields, data: ChangeFieldsData }
export type StageCloseTasksTrigger = { type: TriggerType.CloseTasks, data: CloseTasksData }
export type StageDeleteFilesTrigger = { type: TriggerType.DeleteFiles, data: DeleteFilesData }
export type StageSendEmailTrigger = { type: TriggerType.SendEmail, data: SendEmailData }
export type StageCreateDealTrigger = { type: TriggerType.CreateDeal, data: CreateDealData }

export type Triggers = 
|  ChangeAgentTrigger
|  TaskTrigger
|  ChangeFieldsTrigger
|  CloseTasksTrigger
|  DeleteFilesTrigger
|  SendEmailTrigger
|  CreateDealTrigger

export type Trigger = BaseTrigger & Triggers;

export type StageTriggers =
|  StageTaskTrigger
|  StageChangeAgentTrigger
|  StageChangeFieldsTrigger
|  StageCloseTasksTrigger
|  StageDeleteFilesTrigger
|  StageSendEmailTrigger
|  StageCreateDealTrigger

export type StageTrigger = BaseStageTrigger & StageTriggers;