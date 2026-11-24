/**
 * «История событий»: the business events of the CRM (messages, calls, letters, notes, tasks…) and the
 * journal of changes of data (who changed what, when and from where) in one history — the journal page
 * (pages/analytics/events) and the cards of a deal, a company, a contact and an employee
 * (CardHistory.vue). The API renders the changes already (src/audit/audit-render.ts): the object by its
 * name, the attributes with Russian names, values as people read them. Here they are grouped the way the
 * version history of 1C shows them: a day → an operation (one save: who, when, from where) → its objects →
 * their attributes «было → стало».
 */
import { DealEventType } from '~/types/deal';
import {
    EVENT_MOVED,
    EVENT_TASK_UPDATE,
    dayKey,
    dayLabel,
    durationOf,
    fieldLabel,
    fieldValue,
    isOutgoing,
    personName,
    taskChanges,
} from '~/components/common/feed';

export type AuditScope = 'all' | 'deal' | 'company' | 'user';
/** all: events and changes together; changes: only the journal of changes; events: only the business events */
export type AuditKind = 'all' | 'changes' | 'events';

export interface AuditField {
    field: string;
    label: string;
    before: string | null;
    after: string | null;
    delta?: string | null;
    /** one value, not «было → стало» (a secret «изменён») */
    single?: boolean;
}

export interface AuditChange {
    kind: 'change';
    id: string;
    at: string;
    batch: string;
    request_id: string | null;
    actor: { id: number | null; name: string; deleted: boolean; automation: boolean };
    source: string;
    source_label: string | null;
    source_text: string | null;
    caused_by: string | null;
    action: string;
    action_text: string;
    entity: string;
    entity_text: string;
    entity_id: string | null;
    object: string;
    link: string | null;
    deal_id: number | null;
    company_id: number | null;
    contact_id: number | null;
    fields: AuditField[];
    summary: string | null;
}

export interface AuditEventItem {
    kind: 'event';
    id: string;
    at: string;
    event: any;
}

export type AuditItem = AuditChange | AuditEventItem;

export interface AuditPage {
    data: AuditItem[];
    count: number;
    page_size: number;
    current_page: number;
    last_page: number;
    /** when the journal of changes was switched on: older changes are only among the events */
    journal_start: string | null;
}

export interface AuditMeta {
    entities: { key: string; name: string; group: string }[];
    actions: { key: string; name: string }[];
    sources: { key: string; name: string }[];
}

/** One save of a person or of the automation (a batch): its objects with their attributes. */
export interface AuditOperation {
    type: 'operation';
    key: string;
    at: string;
    who: string;
    whoLink: string | null;
    automation: boolean;
    deleted: boolean;
    source: string;
    sourceLabel: string | null;
    sourceText: string | null;
    causedBy: string | null;
    items: AuditChange[];
}

/** A business event in one line: what happened, with what, by whom. */
export interface AuditEventView {
    type: 'event';
    key: string;
    at: string;
    who: string;
    sourceLabel: string | null;
    title: string;
    object: string;
    link: string | null;
    before: string;
    after: string;
}

export type AuditBlock = AuditOperation | AuditEventView;

export interface AuditDay {
    key: string;
    label: string;
    blocks: AuditBlock[];
}

/** The badge of who acted when it was not a person in the CRM. */
export const SOURCE_NAMES: Record<string, string> = {
    bot: 'бот',
    trigger: 'триггер',
    autopilot: 'автопилот',
    telegram: 'Telegram',
    whatsapp: 'WhatsApp',
    ftp: 'FTP',
    ai: 'ИИ',
    mail: 'почта',
    system: 'система',
};

/** The colour of the kind of a change: added, removed, changed. */
export function actionTone(change: AuditChange): 'add' | 'del' | 'chg' | 'info' {
    if (['insert', 'restore', 'login'].includes(change.action)) return 'add';
    if (['delete', 'soft_delete', 'login_failed'].includes(change.action)) return 'del';
    if (['logout', 'baseline'].includes(change.action)) return 'info';
    return 'chg';
}

export const TONE_CLASSES: Record<string, string> = {
    add: 'bg-success-500/10 text-success-700 dark:bg-success-500/20 dark:text-success-300',
    del: 'bg-danger-500/10 text-danger-700 dark:bg-danger-500/20 dark:text-danger-300',
    chg: 'bg-primary-500/10 text-primary-700 dark:bg-primary-500/20 dark:text-primary-200',
    info: 'bg-muted-200 text-muted-700 dark:bg-muted-700 dark:text-muted-200',
};

/** 14:05 */
export function hhmm(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 24.11.2026 */
export function ddmmyyyy(value: string | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

// ------------------------------------------------------------------ the business events in one line

const EVENT_TITLES: Record<number, string> = {
    [DealEventType.NewDeal]: 'Новая сделка',
    [DealEventType.NewStage]: 'Смена этапа',
    [DealEventType.NewComment]: 'Примечание',
    [DealEventType.NewChatMessage]: 'Внутреннее сообщение',
    [DealEventType.NewCompany]: 'Компания в сделке',
    [DealEventType.NewCtrAgent]: 'Контакт в сделке',
    [DealEventType.NewSMS]: 'СМС',
    [DealEventType.NewTask]: 'Новая задача',
    [EVENT_TASK_UPDATE]: 'Задача изменена',
    [DealEventType.NewTaskStatus]: 'Задача выполнена',
    [DealEventType.NewCallRecording]: 'Звонок',
    [DealEventType.NewTelegramCall]: 'Звонок в Telegram',
    [DealEventType.NewEmail]: 'Письмо',
    [DealEventType.NewFieldValue]: 'Новое значение поля',
    [DealEventType.NewUpdatedFieldValue]: 'Изменение поля',
    [DealEventType.NewTelegramMessage]: 'Сообщение Telegram',
    [DealEventType.NewWhatsAppMessage]: 'Сообщение WhatsApp',
    [DealEventType.NewProduct]: 'Товар в сделке',
    [EVENT_MOVED]: 'Перенос в другую сделку',
};

/** The types of the business events for the filter of the journal page. */
export const EVENT_TYPES: { id: number; label: string }[] = Object.entries(EVENT_TITLES).map(([id, label]) => ({ id: Number(id), label }));

function short(text: unknown, max = 160): string {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** «Триггер №5», «Автопилот CRM»… for an entry the automation wrote; null for a person. */
function automationName(event: any): string | null {
    const source = event?.source;
    if (!source || source === 'web') return null;
    const trigger = /^trigger:(\d+)$/.exec(String(event?.source_ref ?? ''));
    if (source === 'trigger') return trigger ? `Триггер №${trigger[1]}` : 'Триггер';
    if (source === 'autopilot') return 'Автопилот CRM';
    return null;
}

export function eventView(item: AuditEventItem): AuditEventView {
    const log = item.event ?? {};
    const data = log.after_state?.data ?? {};
    const automation = automationName(log);
    const view: AuditEventView = {
        type: 'event',
        key: item.id,
        at: item.at,
        who: automation ?? personName(log.originated_by),
        sourceLabel: log.source && log.source !== 'web' ? SOURCE_NAMES[log.source] ?? log.source : null,
        title: EVENT_TITLES[log.type] ?? 'Событие',
        object: '',
        link: null,
        before: '',
        after: '',
    };
    if (log.type === DealEventType.NewFieldValue || log.type === DealEventType.NewUpdatedFieldValue) {
        view.title = `${log.type === DealEventType.NewFieldValue ? 'Новое значение' : 'Изменено'}: ${fieldLabel(data.field, log.field_of, data.subject)}`;
    } else if (log.type === DealEventType.NewCallRecording) {
        view.title = isOutgoing(log) ? 'Исходящий звонок' : 'Входящий звонок';
    } else if (log.type === DealEventType.NewEmail) {
        view.title = isOutgoing(log) ? 'Исходящее письмо' : 'Входящее письмо';
    }
    if (log.deal?.id) {
        view.object = `Сделка №${log.deal.display_id ?? log.deal.id}${log.deal.label ? ` «${log.deal.label}»` : ''}`;
        view.link = `/deals/${log.deal.id}`;
    } else if (log.contact?.id) {
        view.object = `Контакт «${personName(log.contact)}»`;
        view.link = `/lists/contacts/${log.contact.id}`;
    } else if (log.company?.id) {
        view.object = `Компания «${log.company.name ?? ''}»`;
        view.link = `/lists/companies/${log.company.id}`;
    }
    switch (log.type) {
        case DealEventType.NewProduct:
            view.after = [data.product?.name, data.quantity ? `${data.quantity} × ${data.price ?? ''}` : ''].filter(Boolean).join(', ');
            break;
        case DealEventType.NewDeal:
            view.after = data.label ?? '';
            if (data.id) view.link = `/deals/${data.id}`;
            break;
        case DealEventType.NewComment:
        case DealEventType.NewChatMessage:
            view.after = short(data.comment ?? data.message);
            break;
        case DealEventType.NewCtrAgent:
            view.after = data.username ?? '';
            break;
        case DealEventType.NewCompany:
            view.after = data.name ?? '';
            break;
        case DealEventType.NewEmail:
            view.after = short(data.subject ?? '');
            break;
        case DealEventType.NewFieldValue:
            view.after = fieldValue(data.field, data.new_value, data.new_label);
            break;
        case DealEventType.NewUpdatedFieldValue:
            view.before = fieldValue(data.field, data.old_value, data.old_label);
            view.after = fieldValue(data.field, data.new_value, data.new_label);
            break;
        case DealEventType.NewStage:
            view.before = log.before_state?.data?.stage?.name ?? '';
            view.after = data.stage?.name ?? '';
            break;
        case DealEventType.NewTask:
        case EVENT_TASK_UPDATE:
        case DealEventType.NewTaskStatus:
            if (log.type === EVENT_TASK_UPDATE) {
                view.after = taskChanges(log.before_state?.data, data).join('; ') || data.label || '';
            } else {
                view.after = log.type === DealEventType.NewTaskStatus ? data.result || data.label || '' : data.label ?? '';
            }
            if (data.id && !view.link) view.link = `/tasks?id=${data.id}`;
            break;
        case DealEventType.NewTelegramMessage:
        case DealEventType.NewWhatsAppMessage: {
            const state = log.after_state?.message !== undefined ? log.after_state : data;
            view.after = short(state?.message) || (state?.files?.length ? 'файл' : '');
            break;
        }
        case DealEventType.NewCallRecording:
        case DealEventType.NewTelegramCall:
            view.after = durationOf(log.duration);
            break;
        case EVENT_MOVED: {
            const to = data.to_deal;
            view.after = to ? `в сделку №${to.display_id ?? to.id} «${to.label ?? ''}»` : '';
            break;
        }
    }
    return view;
}

// ------------------------------------------------------------------ grouping

/**
 * The page (newest first) as days → operations: the changes of one batch next to each other are one
 * operation (a save), an event stands alone.
 */
export function groupHistory(items: AuditItem[]): AuditDay[] {
    const days: AuditDay[] = [];
    let day: AuditDay | null = null;
    let operation: AuditOperation | null = null;
    for (const item of items) {
        const key = dayKey(item.at);
        if (!day || day.key !== key) {
            day = { key, label: dayLabel(item.at), blocks: [] };
            days.push(day);
            operation = null;
        }
        if (item.kind === 'event') {
            day.blocks.push(eventView(item));
            operation = null;
            continue;
        }
        if (operation && operation.key === `${item.batch}|${item.actor.name}`) {
            operation.items.push(item);
            continue;
        }
        operation = {
            type: 'operation',
            key: `${item.batch}|${item.actor.name}`,
            at: item.at,
            who: item.actor.name,
            whoLink: item.actor.id && !item.actor.automation ? `/settings/users/${item.actor.id}` : null,
            automation: item.actor.automation,
            deleted: item.actor.deleted,
            source: item.source,
            sourceLabel: item.source_label,
            sourceText: item.source_text,
            causedBy: item.caused_by,
            items: [item],
        };
        day.blocks.push(operation);
    }
    return days;
}

/** «12 изменений», «1 изменение» */
export function changesWord(n: number): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    const word = mod10 === 1 && mod100 !== 11 ? 'запись' : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? 'записи' : 'записей';
    return `${n} ${word}`;
}
