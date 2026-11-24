<script setup lang="ts">
// The form of one trigger of a stage: conditions, when, what it does, the history of its runs. It opens
// as a wide panel over the page (it used to be a narrow dropdown inside the stage column, cut off by the
// scrolling list and hard to read); read-only for those who may not change triggers.
import { onKeyStroke } from '@vueuse/core';
import type { Filler } from '~/types/filler';
import { type ApplyWhen, type DealFilter, type Stage, type Trigger, TriggerType } from '~/types/stage';
import { type User, UserRole } from '~/types/user';

import ChangeAgentTrigger from './change-agent-trigger.vue';
import ChangeFieldsTrigger from './change-fields-trigger.vue';
import CloseTaskTrigger from './close-task-trigger.vue';
import CreateDealTrigger from './create-deal-trigger.vue';
import DeleteFilesTrigger from './delete-files-trigger.vue';
import EmailTrigger from './email-trigger.vue';
import MoveStageTrigger from './move-stage-trigger.vue';
import NotifyTrigger from './notify-trigger.vue';
import TaskTrigger from './task-trigger.vue';
import TriggerRuns from './trigger-runs.vue';
import { actionNames, sourceNames, toStageTrigger } from './trigger';

const props = defineProps<{
    trigger: Trigger;
    stage: Stage;
    stages?: Stage[];
    users: User[];
    fillers: Filler[];
    // what the saved trigger names and is gone (GET /stages/:id/triggers): shown on top
    problems?: string[];
    // the user may change triggers (admin, manager); otherwise the form only shows the trigger
    readonly?: boolean;
}>();

const emits = defineEmits<{
    (e: 'cancel'): void;
    (e: 'done'): void;
    (e: 'remove', trigger: Trigger): void;
}>();

const dealFilter = ref<DealFilter>();
const whenPicker = ref<HTMLDetailsElement>();
const error = ref('');

// the delay after entering the stage: any number of minutes, hours or days (0 = at once)
const UNITS: [number, string][] = [[1, 'мин'], [60, 'ч'], [1440, 'дн.']];
function delayText(minutes: number): string {
    if (!minutes) return 'Сразу';
    const [unit, name] = [...UNITS].reverse().find(([u]) => minutes % u === 0) ?? UNITS[0];
    return `Через ${minutes / unit} ${name}`;
}
const weekDays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// The "when" of the trigger. Kept in one place and written back to trigger.apply_when
// on every change (before, the picker was not connected to the saved data at all).
const saved = (props.trigger.apply_when ?? { when: 'right_away', after_minutes: 0 }) as any;
const pad = (n: number) => String(n).padStart(2, '0');
const today = new Date();
const INTERVALS = ['every_day', 'every_week', 'every_month', 'every_year'];
// what the client or the manager does in the deal
const EVENT_KINDS = ['tg_message_received', 'wa_message_received', 'email_received', 'call_recorded'];
// (a «when» this form does not know, made by hand or by a newer version, is kept as it is: buildApplyWhen)
const isEvent = (kind: string) => EVENT_KINDS.includes(kind);

// How often the trigger may act for one deal; not saved yet = what the API does by default:
// "create deal" once (a deal that comes back gets no second copy), "send email" once a day.
function defaultRepeat(): string {
    if (props.trigger.type === TriggerType.CreateDeal) return 'once';
    if (props.trigger.type === TriggerType.SendEmail) return '1440';
    return 'every';
}
function savedRepeat(): string {
    if (saved.once_per_deal === true) return 'once';
    if (saved.once_per_deal === false || (saved.cooldown_minutes !== undefined && saved.cooldown_minutes !== null)) {
        const minutes = Number(saved.cooldown_minutes ?? 0);
        return minutes > 0 ? String(minutes) : 'every';
    }
    return defaultRepeat();
}

const savedMinutes = Number(saved.after_minutes ?? 0);
const savedUnit = [...UNITS].reverse().find(([u]) => savedMinutes > 0 && savedMinutes % u === 0)?.[0] ?? 1;
const when = reactive({
    kind: INTERVALS.includes(saved.when) ? 'interval' : saved.when as string,
    // right_away: the delay as a number and a unit; no_reply: minutes the client waits
    delayAmount: saved.when === 'no_reply' ? 0 : savedMinutes / savedUnit,
    delayUnit: saved.when === 'no_reply' ? 1 : savedUnit,
    waitMinutes: saved.when === 'no_reply' ? savedMinutes || 30 : 30,
    date: saved.date ? String(saved.date).slice(0, 10) : `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    time: saved.time || '10:00',
    interval: INTERVALS.includes(saved.when) ? saved.when as string : 'every_day',
    weekDay: Number(saved.week_day ?? 1),
    day: Number(saved.day ?? 1),
    month: Number(saved.month ?? 1),
    // a saved event trigger keeps its direction; a new one waits for the client (incoming): with
    // «любом» a trigger also fires on the manager's own messages and letters
    direction: saved.outgoing === true ? 'outgoing' : saved.outgoing === false ? 'incoming' : isEvent(saved.when) ? 'any' : 'incoming',
    // the employee of the event: 0 = any
    staffId: Number(saved.from_user_id ?? 0),
    repeat: savedRepeat(),
});

const afterMinutes = computed(() => Math.max(0, Math.round(Number(when.delayAmount) * when.delayUnit)) || 0);

// repeats are about events and entering the stage; a schedule repeats by itself, an exact time is once
const repeatApplies = computed(() => when.kind === 'right_away' || when.kind === 'no_reply' || isEvent(when.kind));

function withRepeat(value: any): ApplyWhen {
    if (!repeatApplies.value) return value as ApplyWhen;
    value.once_per_deal = when.repeat === 'once';
    value.cooldown_minutes = when.repeat === 'once' || when.repeat === 'every' ? 0 : Number(when.repeat) || 0;
    return value as ApplyWhen;
}

function buildApplyWhen(): ApplyWhen {
    switch (when.kind) {
        case 'at_exact_time':
            return { when: 'at_exact_time', date: when.date, time: when.time };
        case 'interval':
            if (when.interval === 'every_week') return { when: 'every_week', time: when.time, week_day: when.weekDay };
            if (when.interval === 'every_month') return { when: 'every_month', time: when.time, day: when.day };
            if (when.interval === 'every_year') return { when: 'every_year', time: when.time, day: when.day, month: when.month };
            return { when: 'every_day', time: when.time };
        case 'tg_message_received':
        case 'wa_message_received':
        case 'email_received':
        case 'call_recorded': {
            const value: any = { when: when.kind };
            if (when.direction !== 'any') value.outgoing = when.direction === 'outgoing';
            if (when.staffId) value.from_user_id = when.staffId;
            return withRepeat(value);
        }
        case 'right_away':
            return withRepeat({ when: 'right_away', after_minutes: afterMinutes.value });
        case 'no_reply':
            return withRepeat({ when: 'no_reply', after_minutes: Math.max(1, Math.round(Number(when.waitMinutes)) || 1) });
        default:
            // unknown here: saved as it came
            return { ...saved } as ApplyWhen;
    }
}

watch(when, () => {
    props.trigger.apply_when = buildApplyWhen();
}, { deep: true, immediate: true });

const directionWord = (incoming: string, outgoing: string, any: string) =>
    when.direction === 'incoming' ? incoming : when.direction === 'outgoing' ? outgoing : any;

const whenSummary = computed(() => {
    const d = (s: string) => s.split('-').reverse().join('.');
    const staff = when.staffId ? employees.value.find((e) => e.id === when.staffId)?.username : '';
    const by = staff ? ` (сотрудник ${staff})` : '';
    switch (when.kind) {
        case 'at_exact_time': return `${d(when.date)} в ${when.time}`;
        case 'interval':
            if (when.interval === 'every_week') return `Каждую неделю, ${weekDays[when.weekDay - 1]?.toLowerCase()} в ${when.time}`;
            if (when.interval === 'every_month') return `Каждый месяц, ${when.day}-го в ${when.time}`;
            if (when.interval === 'every_year') return `Каждый год, ${when.day} ${months[when.month - 1]?.toLowerCase()} в ${when.time}`;
            return `Ежедневно в ${when.time}`;
        case 'tg_message_received':
            return directionWord('При входящем сообщении Telegram', 'При исходящем сообщении Telegram', 'При сообщении в Telegram') + by;
        case 'wa_message_received':
            return directionWord('При входящем сообщении WhatsApp', 'При исходящем сообщении WhatsApp', 'При сообщении в WhatsApp') + by;
        case 'email_received':
            return directionWord('При входящем письме', 'При исходящем письме', 'При письме') + by;
        case 'call_recorded':
            return directionWord('При записи входящего звонка', 'При записи исходящего звонка', 'При записи звонка') + by;
        case 'right_away':
            return afterMinutes.value ? `${delayText(afterMinutes.value)} после создания или перехода в этап` : 'Сразу после создания или перехода в этап';
        case 'no_reply':
            return `Если клиент ждёт ответа ${when.waitMinutes} мин (рабочее время)`;
        default:
            return `Условие «${when.kind}» (настроено вне этой формы)`;
    }
});

const repeatOptions = computed(() => {
    const list: [string, string][] = isEvent(when.kind) || when.kind === 'no_reply'
        ? [['every', 'каждый раз'], ['60', 'не чаще раза в час'], ['180', 'не чаще раза в 3 часа'], ['1440', 'не чаще раза в сутки'], ['once', 'только один раз для сделки']]
        : [['every', 'при каждом входе в этап'], ['1440', 'не чаще раза в сутки'], ['once', 'только один раз для сделки']];
    if (!list.some(([value]) => value === when.repeat)) list.push([when.repeat, `не чаще раза в ${when.repeat} мин`]);
    return list;
});

const employees = computed(() => props.users.filter((u) => u.role !== UserRole.CtrAgent));

const conditions = computed(() => {
    const data: DealFilter[] = [
        {label: 'Ответственный', field: 'agent_id', is_filler: false, value: ''},
        {label: 'Бюджет', field: 'budget', is_filler: false, value: ''},
        {label: 'Источник сделки', field: 'source', is_filler: false, value: ''},
    ];
    for (const filler of props.fillers) {
        data.push({ label: filler.field, field: filler.field, is_filler: true, value: '', filler_id: filler.id });
    }
    return data;
});

function filterLabel(filter: DealFilter) {
    // a custom field by its id first: its name may have changed since the trigger was saved
    const byId = filter.is_filler && filter.filler_id ? conditions.value.find((c) => c.filler_id === filter.filler_id) : undefined;
    return byId?.label || filter.label || conditions.value.find((c) => c.field === filter.field && !!c.is_filler === !!filter.is_filler)?.label || filter.field;
}

function onFilterRemove(idx: number) {
    props.trigger.deal_filters.splice(idx, 1);
}

// how a condition compares: the responsible and the source are equal or not, numbers and texts more
const OPS: Record<string, string> = { eq: 'равно', ne: 'не равно', gt: 'больше', lt: 'меньше', contains: 'содержит' };
function opsOf(filter: DealFilter): string[] {
    if (!filter.is_filler && (filter.field === 'agent_id' || filter.field === 'source')) return ['eq', 'ne'];
    if (!filter.is_filler && filter.field === 'budget') return ['eq', 'ne', 'gt', 'lt'];
    return ['eq', 'ne', 'gt', 'lt', 'contains'];
}
const isNumber = (value: unknown) => /^-?[0-9]+([.,][0-9]+)?$/.test(String(value ?? '').replace(/[ ]+/g, ''));

function closeWhenPicker() {
    whenPicker.value?.removeAttribute('open');
}

/** Everything the trigger needs, before it is kept (the API checks again and names what is wrong). */
function validate(): string {
    const t = props.trigger as any;
    if (when.kind === 'at_exact_time' && !when.date) return 'Укажите дату';
    if ((when.kind === 'at_exact_time' || when.kind === 'interval') && !/^[0-9]{2}:[0-9]{2}$/.test(when.time)) return 'Укажите время';
    if (when.kind === 'right_away' && (!Number.isFinite(Number(when.delayAmount)) || Number(when.delayAmount) < 0)) return 'Задержка — число не меньше 0';
    if (when.kind === 'no_reply' && !(Number(when.waitMinutes) >= 1)) return 'Укажите, сколько минут клиент ждёт ответа';
    if ((when.kind === 'interval') && (when.interval === 'every_month' || when.interval === 'every_year') && !(when.day >= 1 && when.day <= 31)) return 'Число месяца — от 1 до 31';
    for (const f of props.trigger.deal_filters) {
        const value = String(f.value ?? '').trim();
        if (!value) return `Заполните условие «${filterLabel(f)}»`;
        if ((f.op === 'gt' || f.op === 'lt' || (!f.is_filler && f.field === 'budget')) && !isNumber(value)) return `Условие «${filterLabel(f)}»: укажите число`;
    }
    switch (t.type) {
        case TriggerType.CreateDeal:
            if (!t.create_deal_data?.stage_id) return 'Выберите этап для новой сделки';
            break;
        case TriggerType.MoveStage:
            if (!t.move_stage_data?.stage_id) return 'Выберите этап, куда перевести сделку';
            break;
        case TriggerType.SendEmail:
            if (!t.send_email_data?.template_id) return 'Выберите шаблон письма';
            break;
        case TriggerType.ChangeAgent: {
            const rotation = t.change_agent_data?.rotate_user_ids ?? [];
            if (rotation.length === 1) return 'Для раздачи по очереди выберите хотя бы двух сотрудников';
            if (!rotation.length && !t.change_agent_data?.agent_id) return 'Выберите ответственного';
            break;
        }
        case TriggerType.ChangeFields:
            if (!t.change_fields_data?.fields?.length) return 'Добавьте хотя бы одно поле';
            for (const f of t.change_fields_data.fields as DealFilter[]) {
                const value = String(f.value ?? '').trim();
                if (!f.is_filler && f.field === 'agent_id' && !value) return 'Выберите нового ответственного';
                if (!f.is_filler && f.field === 'budget' && !isNumber(value)) return 'Бюджет — число';
                if (!f.is_filler && f.field === 'label' && !value) return 'Укажите новое название сделки';
            }
            break;
        case TriggerType.CreateTask:
            if (!String(t.create_task_data?.label ?? '').trim()) return 'Напишите текст задачи, например «Позвонить клиенту»';
            if (!t.create_task_data?.type_id) return 'Выберите тип задачи';
            break;
        case TriggerType.CloseTasks:
            if (!String(t.close_tasks_data?.result ?? '').trim()) return 'Укажите результат закрытия задач';
            break;
        case TriggerType.DeleteFiles: {
            const d = t.delete_files_data ?? {};
            if (!d.which_files?.length && !d.with_extensions?.length && !d.from_bytes && !d.till_bytes) return 'Выберите, какие файлы удалять: без условий триггер ничего не удалит';
            break;
        }
        case TriggerType.Notify:
            if (!String(t.notify_data?.text ?? '').trim()) return 'Напишите текст уведомления';
            break;
    }
    return '';
}

// «что произойдёт»: the trigger in one sentence, under the form
function valueText(filter: DealFilter): string {
    if (!filter.is_filler && filter.field === 'agent_id') return employees.value.find((e) => String(e.id) === String(filter.value))?.username ?? String(filter.value ?? '');
    if (!filter.is_filler && filter.field === 'source') return sourceNames[String(filter.value)] ?? String(filter.value ?? '');
    return String(filter.value ?? '');
}
const conditionsSummary = computed(() => props.trigger.deal_filters
    .filter((f) => String(f.value ?? '').trim())
    .map((f) => `${filterLabel(f)} ${OPS[f.op ?? 'eq']} «${valueText(f)}»`)
    .join(' и '));
const summary = computed(() => {
    const action = actionNames[props.trigger.type] ?? 'действие';
    const deals = conditionsSummary.value ? `для сделок, у которых ${conditionsSummary.value}` : 'для каждой сделки этапа';
    return `${whenSummary.value} — «${action}» ${deals}.`;
});

onKeyStroke('Escape', () => emits('cancel'));

async function onTriggerSave() {
    if (props.readonly) return;
    error.value = validate();
    if (error.value) return;
    const values = toStageTrigger(props.trigger);
    const existing = props.stage.triggers.find((t) => t.id === props.trigger.id);
    if (existing) {
        // a saved trigger or a new one opened again: replace, never duplicate. «Сохранить» of the
        // funnel sends only the changed ones (a PATCH used to void the planned runs of every trigger)
        props.stage.triggers = props.stage.triggers.map((t) => t.id === props.trigger.id
            ? ({...t, ...values, status: t.status === 'new' ? 'new' : 'changed'})
            : t);
    } else {
        props.stage.triggers.push(Object.assign(values, {id: props.trigger.id, status: 'new'}));
    }
    emits('done');
}

watch(dealFilter, () => {
    if (!dealFilter.value) return;
    props.trigger.deal_filters.push({
        is_filler: !!dealFilter.value.is_filler,
        field: dealFilter.value.field || '',
        value: '',
        label: dealFilter.value.label || '',
        ...(dealFilter.value.filler_id ? { filler_id: dealFilter.value.filler_id } : {}),
    });
    nextTick(() => (dealFilter.value = undefined));
});
</script>
<template>
    <Teleport to="body">
    <div class="fixed inset-0 z-[60] overflow-y-auto bg-muted-900/50 px-2 py-4 sm:px-6 sm:py-10">
    <div class="trigger-dropdown relative mx-auto w-full max-w-2xl rounded-lg border border-muted-200 bg-white text-[15px] shadow-xl dark:border-muted-700 dark:bg-muted-800">
        <header class="flex items-start justify-between gap-3 border-b border-muted-200 px-4 py-3 dark:border-muted-700">
            <div class="min-w-0">
                <p class="text-xs text-muted-500 dark:text-muted-400">Триггер этапа «{{ stage.name || 'новый этап' }}»{{ readonly ? ' · только просмотр' : '' }}</p>
                <h3 class="text-lg font-semibold text-muted-800 dark:text-white">{{ actionNames[trigger.type] ?? 'Триггер' }}</h3>
            </div>
            <BaseButtonClose size="sm" rounded="full" @click="emits('cancel')" />
        </header>
        <form @submit.prevent="onTriggerSave">
            <div v-if="problems?.length" class="px-4 py-2 text-sm text-rose-700 bg-rose-50 dark:bg-rose-500/10 dark:text-rose-300">
                <p class="font-medium">Триггер не сможет сработать:</p>
                <ul class="list-disc ps-5">
                    <li v-for="problem in problems" :key="problem">{{ problem }}</li>
                </ul>
                <p v-if="!readonly" class="text-xs">Исправьте настройку и нажмите «Готово», затем «Сохранить».</p>
            </div>
            <fieldset :disabled="readonly" class="min-w-0">
            <section class="bg-muted-100 p-3 dark:bg-muted-900">
                <span class="text-muted-700 text-sm dark:text-muted-200">
                    Для всех сделок у которых:
                </span>
                <ul v-if="trigger.deal_filters.length" class="flex flex-col gap-2 mb-2 mt-1">
                    <li v-for="(filter, idx) in trigger.deal_filters" :key="filter.field + idx" class="flex items-center gap-2">
                        <div class="border border-muted-200 rounded-md flex items-center flex-1 bg-white dark:bg-muted-900 dark:border-muted-700">
                            <span class="text-sm text-muted-700 ms-3 whitespace-nowrap dark:text-muted-200"> {{ idx >= 1 ? 'И ' : '' }}
                                {{ filterLabel(filter) }}
                            </span>
                            <select
                                :value="filter.op ?? 'eq'"
                                class="bg-transparent text-primary-600 text-sm underline underline-offset-2 outline-none ms-2 dark:text-primary-200"
                                @change="(e) => filter.op = ((e.target as HTMLSelectElement).value === 'eq' ? undefined : (e.target as HTMLSelectElement).value) as DealFilter['op']"
                            >
                                <option v-for="op in opsOf(filter)" :key="op" :value="op">{{ OPS[op] }}</option>
                            </select>
                            <select
                                v-if="filter.field === 'source' && !filter.is_filler"
                                v-model="filter.value"
                                class="w-full bg-transparent px-2 py-2 text-sm outline-none"
                            >
                                <option value="" disabled>Выберите канал</option>
                                <option v-for="(name, key) in sourceNames" :key="key" :value="key">{{ name }}</option>
                            </select>
                            <BaseAutocomplete
                                v-else-if="filter.field === 'agent_id'"
                                :classes="{input: 'border-none !outline-none'}"
                                :items="employees"
                                :properties="{label: 'username', value: 'id'}"
                                :fixed="true"
                                dropdown
                                name="agent"
                                :placeholder="employees.find((e) => String(e.id) === String(filter.value))?.username || 'Выберите сотрудника'"
                                @change="(user: User) => filter.value = String(user.id)"
                            />
                            <BaseInput v-else :name="filter.field" v-model="filter.value" :classes="{input: 'border-none !outline-none', wrapper: 'w-full'}" />
                        </div>
                        <BaseButtonClose size="sm" rounded="full" color="danger" @click="onFilterRemove(idx)" />
                    </li>
                </ul>
                <BaseListbox
                    :items="conditions"
                    :properties="{value: 'field', label: 'label'}"
                    placeholder="Добавить условие"
                    v-model="dealFilter"
                    :classes="{input: 'border-dashed', wrapper: 'pr-10'}"
                />
            </section>
            <section>
                <details class="group relative p-3 pr-[3.25rem]" ref="whenPicker" v-click-outside="closeWhenPicker">
                    <summary class="border border-muted-200 rounded-md px-3 p-2.5 text-sm text-muted-700 flex justify-between items-center cursor-pointer dark:border-muted-700 dark:text-muted-200 dark:bg-muted-900">
                        <span>Выполнить: {{ whenSummary }}</span>
                        <Icon name="ph:caret-right" class="transition-transform duration-300 group-open:rotate-90"/>
                    </summary>
                    <div class="absolute top-full left-1 bg-white w-full z-20 border border-muted-200 max-h-96 overflow-y-auto dark:bg-muted-800 dark:border-muted-700 text-sm">
                        <div class="uppercase text-xs font-semibold py-2 px-7 bg-muted-200 dark:bg-muted-900">Триггеры воронки</div>
                        <label class="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted-100 dark:hover:bg-muted-700 flex-wrap">
                            <input type="radio" value="right_away" v-model="when.kind" class="accent-primary-600" />
                            <span>Через</span>
                            <input type="number" min="0" step="1" v-model.number="when.delayAmount" class="border border-muted-300 outline-none px-2 py-1 rounded-[4px] w-20 dark:border-muted-700 dark:bg-muted-900" @focus="when.kind = 'right_away'" />
                            <select v-model.number="when.delayUnit" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200" @click="when.kind = 'right_away'">
                                <option v-for="[unit, name] in UNITS" :key="unit" :value="unit">{{ name }}</option>
                            </select>
                            <span>после создания или перехода в этап (0 — сразу)</span>
                        </label>
                        <div class="uppercase text-xs font-semibold py-2 px-7 bg-muted-200 dark:bg-muted-900">Триггеры по времени</div>
                        <label class="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted-100 dark:hover:bg-muted-700 flex-wrap">
                            <input type="radio" value="at_exact_time" v-model="when.kind" class="accent-primary-600" />
                            <span>Точное время</span>
                            <input type="date" v-model="when.date" class="border border-muted-300 outline-none px-2 py-1 rounded-[4px] dark:border-muted-700 dark:bg-muted-900" @focus="when.kind = 'at_exact_time'" />
                            <span>в</span>
                            <input type="time" v-model="when.time" class="border border-muted-300 outline-none px-2 py-1 rounded-[4px] dark:border-muted-700 dark:bg-muted-900" @focus="when.kind = 'at_exact_time'" />
                        </label>
                        <label class="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted-100 dark:hover:bg-muted-700 flex-wrap">
                            <input type="radio" value="interval" v-model="when.kind" class="accent-primary-600" />
                            <select v-model="when.interval" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200" @click="when.kind = 'interval'">
                                <option value="every_day">Ежедневно</option>
                                <option value="every_week">Раз в неделю</option>
                                <option value="every_month">Раз в месяц</option>
                                <option value="every_year">Раз в год</option>
                            </select>
                            <select v-if="when.interval === 'every_week'" v-model.number="when.weekDay" class="bg-transparent text-primary-600 underline outline-none dark:text-primary-200">
                                <option v-for="(name, i) in weekDays" :key="name" :value="i + 1">{{ name }}</option>
                            </select>
                            <template v-if="when.interval === 'every_month' || when.interval === 'every_year'">
                                <input type="number" min="1" max="31" v-model.number="when.day" class="border border-muted-300 outline-none px-2 py-1 rounded-[4px] w-16 dark:border-muted-700 dark:bg-muted-900" />
                                <span>числа</span>
                            </template>
                            <select v-if="when.interval === 'every_year'" v-model.number="when.month" class="bg-transparent text-primary-600 underline outline-none dark:text-primary-200">
                                <option v-for="(name, i) in months" :key="name" :value="i + 1">{{ name }}</option>
                            </select>
                            <span>в</span>
                            <input type="time" v-model="when.time" class="border border-muted-300 outline-none px-2 py-1 rounded-[4px] dark:border-muted-700 dark:bg-muted-900" @focus="when.kind = 'interval'" />
                        </label>
                        <div class="uppercase text-xs font-semibold py-2 px-7 bg-muted-200 dark:bg-muted-900">Триггеры по действиям клиента</div>
                        <label class="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted-100 dark:hover:bg-muted-700 flex-wrap">
                            <input type="radio" value="tg_message_received" v-model="when.kind" class="accent-primary-600" />
                            <span>При</span>
                            <select v-model="when.direction" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200" @click="when.kind = 'tg_message_received'">
                                <option value="incoming">входящем</option>
                                <option value="outgoing">исходящем</option>
                                <option value="any">любом</option>
                            </select>
                            <span>сообщении в Telegram</span>
                        </label>
                        <label class="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted-100 dark:hover:bg-muted-700 flex-wrap">
                            <input type="radio" value="wa_message_received" v-model="when.kind" class="accent-primary-600" />
                            <span>При</span>
                            <select v-model="when.direction" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200" @click="when.kind = 'wa_message_received'">
                                <option value="incoming">входящем</option>
                                <option value="outgoing">исходящем</option>
                                <option value="any">любом</option>
                            </select>
                            <span>сообщении в WhatsApp</span>
                        </label>
                        <label class="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted-100 dark:hover:bg-muted-700 flex-wrap">
                            <input type="radio" value="email_received" v-model="when.kind" class="accent-primary-600" />
                            <span>При</span>
                            <select v-model="when.direction" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200" @click="when.kind = 'email_received'">
                                <option value="incoming">входящем</option>
                                <option value="outgoing">исходящем</option>
                                <option value="any">любом</option>
                            </select>
                            <span>письме</span>
                        </label>
                        <label class="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted-100 dark:hover:bg-muted-700 flex-wrap">
                            <input type="radio" value="call_recorded" v-model="when.kind" class="accent-primary-600" />
                            <span>При записи</span>
                            <select v-model="when.direction" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200" @click="when.kind = 'call_recorded'">
                                <option value="incoming">входящего</option>
                                <option value="outgoing">исходящего</option>
                                <option value="any">любого</option>
                            </select>
                            <span>звонка</span>
                        </label>
                        <label class="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted-100 dark:hover:bg-muted-700 flex-wrap">
                            <input type="radio" value="no_reply" v-model="when.kind" class="accent-primary-600" />
                            <span>Если клиент ждёт ответа</span>
                            <input type="number" min="1" step="1" v-model.number="when.waitMinutes" class="border border-muted-300 outline-none px-2 py-1 rounded-[4px] w-20 dark:border-muted-700 dark:bg-muted-900" @focus="when.kind = 'no_reply'" />
                            <span>мин (рабочее время): написал и ему не ответили и не перезвонили</span>
                        </label>
                        <label v-if="isEvent(when.kind)" class="flex items-center gap-2 p-2 ps-8 flex-wrap text-muted-600 dark:text-muted-300">
                            <span>Сотрудник:</span>
                            <select v-model.number="when.staffId" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200 max-w-[14rem]">
                                <option :value="0">любой</option>
                                <option v-for="employee in employees" :key="employee.id" :value="employee.id">{{ employee.username }}</option>
                            </select>
                            <span class="text-xs text-muted-400 basis-full ps-[4.75rem]">чей чат, звонок или письмо; у входящих сообщений и писем — ответственный за сделку</span>
                        </label>
                        <div class="p-2 flex justify-end">
                            <BaseButton size="sm" type="button" @click="closeWhenPicker">Готово</BaseButton>
                        </div>
                    </div>
                </details>
                <label v-if="repeatApplies" class="flex flex-wrap items-center gap-2 px-3 pb-3 -mt-1 text-sm text-muted-700 dark:text-muted-200">
                    <span>Повторять для сделки:</span>
                    <select v-model="when.repeat" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200">
                        <option v-for="[value, label] in repeatOptions" :key="value" :value="value">{{ label }}</option>
                    </select>
                </label>
            </section>
            <TaskTrigger v-if="trigger.type === TriggerType.CreateTask" :employees="employees" :trigger="trigger" />
            <EmailTrigger v-else-if="trigger.type === TriggerType.SendEmail" :trigger="trigger" :employees="employees" />
            <CloseTaskTrigger v-else-if="trigger.type === TriggerType.CloseTasks" :trigger="trigger" />
            <ChangeAgentTrigger v-else-if="trigger.type === TriggerType.ChangeAgent" :trigger="trigger" :employees="employees" />
            <DeleteFilesTrigger v-else-if="trigger.type === TriggerType.DeleteFiles" :trigger="trigger" />
            <ChangeFieldsTrigger v-else-if="trigger.type === TriggerType.ChangeFields" :trigger="trigger" :fillers="fillers" :employees="employees" />
            <CreateDealTrigger v-else-if="trigger.type === TriggerType.CreateDeal" :trigger="trigger" :stage="stage" :stages="stages ?? []" />
            <MoveStageTrigger v-else-if="trigger.type === TriggerType.MoveStage" :trigger="trigger" :stage="stage" />
            <NotifyTrigger v-else-if="trigger.type === TriggerType.Notify" :trigger="trigger" :employees="employees" />
            </fieldset>
            <p class="mx-3 mb-3 rounded-md bg-muted-50 px-3 py-2 text-sm text-muted-600 dark:bg-muted-900 dark:text-muted-300">
                <span class="font-medium text-muted-700 dark:text-muted-200">Что произойдёт:</span> {{ summary }}
            </p>
            <p v-if="error" class="px-3 pb-2 text-sm text-rose-600">{{ error }}</p>
            <div class="flex items-center justify-between px-3 pb-3">
                <div class="flex gap-2">
                    <BaseButton v-if="!readonly" variant="solid" color="primary" size="sm" type="submit">Готово</BaseButton>
                    <BaseButton variant="pastel" color="default" size="sm" @click="emits('cancel')">{{ readonly ? 'Закрыть' : 'Отменить' }}</BaseButton>
                </div>
                <BaseButtonIcon size="sm" color="danger" type="button" v-if="trigger.id > 0 && !readonly" @click="emits('remove', trigger)">
                    <Icon name="ph:trash" class="size-4" />
                </BaseButtonIcon>
            </div>
        </form>
        <TriggerRuns v-if="trigger.id > 0 && stage.id > 0" :stage-id="stage.id" :trigger-id="trigger.id" :open="!!problems?.length" />
    </div>
    </div>
    </Teleport>
</template>
