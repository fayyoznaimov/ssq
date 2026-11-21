import type { FillerValue } from './filler';
import type { Email } from './mail';
import type { Product } from './product';
import type { Stage } from './stage';
import type { Company, Group, User } from './user';

export type Deal = {
    id: number;
    label: string;
    display_id: number;
    budget: string;
    created_at: string;
    stage: Stage | null;
    agent: User & {user_fillers: FillerValue[]};
    ctr_agents: (User & {user_fillers: FillerValue[]})[];
    company: Company & {company_fillers: FillerValue[]};
    deal_fillers: FillerValue[];
    deal_products: {
        id: number;
        quantity: string;
        price: string;
        product: Product;
    }[];
    // the trash (GET /deals/trash)
    deleted_at?: string | null;
    deleted_by?: User | null;
}

export type DealStats = {
    task_count_for_today: string;
    deals_without_tasks: string;
    deals_with_overdue_tasks: string;
    new_deals_from_today: string;
    new_deals_from_yesterday: string;
}

export type TaskType = {
    id: number;
    name: string;
}

export type TaskFilters = {
    stages: Stage[];
    assignedTo: User[];
    createdBy: User[];
    status: {label: string, value: string};
    taskType: TaskType;
    perPage: number;
    currentPage: number;
    sortBy: Record<string, any>;
    fromDate: string;
    tillDate: string;
}

export type Task = {
    id: number;
    label: string;
    result: null;
    closed_at: string;
    start_time: string;
    // backend guy cannot be consistent
    start: string;
    end_time: string;
    // backend guy cannot be consistent
    end: string;
    created_at: string;
    company: Company | null;
    ctr_agent: User | null;
    agent: User | null;
    group: Group | null;
    deal: Deal | null;
    created_by: User;
    type: TaskType;
    allDay: boolean;
}

export type DealFile = {
    id: number;
    name: string;
    path: string;
    uploaded_by: User;
    deal?: Deal;
    url?: string;
    type?: 'voice' | 'document';
}

export enum DealEventType {
    NewDeal = 0,
    NewCtrAgent = 1,
    NewCompany = 2,
    NewFieldValue = 3,
    NewUpdatedFieldValue = 4,
    NewComment = 5,
    NewTask = 6,
    NewTaskStatus = 7,
    NewChatMessage = 8,
    NewEmail = 9,
    NewCallRecording = 10,
    NewSMS = 11,
    NewTelegramMessage = 12,
    NewTelegramCall = 13,
    NewProduct = 14,
    NewStage = 15,
    NewWhatsAppMessage = 16,
    GroupedEmails = -1,
    GroupedTgMessages = -2,
}

type State<T> = {
    data: T;
};

type BaseDealEvent = {
    id: number;
    created_at: string;
    originated_by: User;
    target_user: User | null;
    target_group: Group | null;
    deal?: Deal | null;
}


type EmailEvent = BaseDealEvent & { type: DealEventType.NewEmail, before_state: State<null>, after_state: State<Email> }
type TelegramMessageEvent = BaseDealEvent & { type: DealEventType.NewTelegramCall, before_state: State<null>, after_state: {name: string, outgoing: boolean, path: string} }
| BaseDealEvent & { 
    type: DealEventType.NewTelegramMessage, 
    before_state: State<null>,
    after_state: {
        contact: User | null;
        files: DealFile[];
        from_user_id: number;
        location: string | null; 
        message: string;
        outgoing: boolean;
        to_user_id: number;
        formData?: FormData;
    }
} 

export type DealEvent = 
| BaseDealEvent & { type: DealEventType.NewDeal, before_state: State<null>, after_state: State<Deal> }
| BaseDealEvent & { type: DealEventType.NewCtrAgent, before_state: State<null>, after_state: State<User> }
| BaseDealEvent & { type: DealEventType.NewCompany, before_state: State<null>, after_state: State<Company> }
| BaseDealEvent & { type: DealEventType.NewComment, before_state: State<null>, after_state: State<{comment: string, files: DealFile[], formData?: FormData}> }
| BaseDealEvent & { type: DealEventType.NewChatMessage, before_state: State<null>, after_state: State<{message: string, files: DealFile[], formData?: FormData}> }
| BaseDealEvent & { type: DealEventType.NewFieldValue, before_state: State<null>, after_state: State<{field: string, new_value: string}> }
| BaseDealEvent & { type: DealEventType.NewUpdatedFieldValue, 
    before_state: State<{field: string, new_value: string}>, 
    after_state: State<{field: string, new_value: string, old_value: string}> }
| BaseDealEvent & { type: DealEventType.NewTask, before_state: State<null>, after_state: State<Task> }
| BaseDealEvent & { type: DealEventType.NewTaskStatus, before_state: State<null>, after_state: State<Task> }
| EmailEvent
| BaseDealEvent & { type: DealEventType.NewProduct, before_state: State<null>, after_state: State<{price: number, quantity: number, product: Product}> }
| BaseDealEvent & { type: DealEventType.NewCallRecording, before_state: State<null>, after_state: {name: string, outgoing: boolean, path: string} }
| BaseDealEvent & { type: DealEventType.NewStage, before_state: State<{stage: Stage}>, after_state: State<{stage: Stage}> }
| TelegramMessageEvent
| BaseDealEvent & { 
    type: DealEventType.GroupedEmails, 
    events: EmailEvent[];
}
| BaseDealEvent & { 
    type: DealEventType.GroupedTgMessages, 
    events: TelegramMessageEvent[];
}

export enum MessageTarget {
    All = 'all',
    Group = 'group',
    User = 'user',
}