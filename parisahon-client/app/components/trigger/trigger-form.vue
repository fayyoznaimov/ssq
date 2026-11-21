<script setup lang="ts">
import type { Filler } from '~/types/filler';
import { type ApplyWhen, type DealFilter, type Stage, type Trigger, TriggerType } from '~/types/stage';
import { type User, UserRole } from '~/types/user';

import ChangeAgentTrigger from './change-agent-trigger.vue';
import ChangeFieldsTrigger from './change-fields-trigger.vue';
import CloseTaskTrigger from './close-task-trigger.vue';
import CreateDealTrigger from './create-deal-trigger.vue';
import DeleteFilesTrigger from './delete-files-trigger.vue';
import EmailTrigger from './email-trigger.vue';
import TaskTrigger from './task-trigger.vue';
import TriggerRuns from './trigger-runs.vue';
import { toStageTrigger } from './trigger';

const props = defineProps<{
    trigger: Trigger;
    stage: Stage;
    stages?: Stage[];
    users: User[];
    fillers: Filler[];
}>();

const emits = defineEmits<{
    (e: 'cancel'): void;
    (e: 'done'): void;
    (e: 'remove', trigger: Trigger): void;
}>();

const dealFilter = ref<DealFilter>();
const whenPicker = ref<HTMLDetailsElement>();
const error = ref('');

const afterMinuteMap: Record<number, string> = {
    0: 'Сразу',
    5: 'Через 5 минут',
    10: 'Через 10 минут',
    30: 'Через 30 минут',
    60: 'Через час',
    1440: 'Через день',
    4320: 'Через 3 дня',
    10080: 'Через неделю',
};
const weekDays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// The "when" of the trigger. Kept in one place and written back to trigger.apply_when
// on every change (before, the picker was not connected to the saved data at all).
const saved = (props.trigger.apply_when ?? { when: 'right_away', after_minutes: 0 }) as any;
const pad = (n: number) => String(n).padStart(2, '0');
const today = new Date();
const when = reactive({
    kind: ['every_day', 'every_week', 'every_month', 'every_year'].includes(saved.when) ? 'interval' : saved.when as string,
    afterMinutes: Number(saved.after_minutes ?? 0),
    date: saved.date ? String(saved.date).slice(0, 10) : `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    time: saved.time || '10:00',
    interval: ['every_day', 'every_week', 'every_month', 'every_year'].includes(saved.when) ? saved.when as string : 'every_day',
    weekDay: Number(saved.week_day ?? 1),
    day: Number(saved.day ?? 1),
    month: Number(saved.month ?? 1),
    direction: saved.outgoing === true ? 'outgoing' : saved.outgoing === false ? 'incoming' : 'any',
});

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
        case 'email_received': {
            const value: ApplyWhen = { when: when.kind } as ApplyWhen;
            if (when.direction !== 'any') (value as any).outgoing = when.direction === 'outgoing';
            return value;
        }
        default:
            return { when: 'right_away', after_minutes: Number(when.afterMinutes) };
    }
}

watch(when, () => {
    props.trigger.apply_when = buildApplyWhen();
}, { deep: true, immediate: true });

const whenSummary = computed(() => {
    const d = (s: string) => s.split('-').reverse().join('.');
    switch (when.kind) {
        case 'at_exact_time': return `${d(when.date)} в ${when.time}`;
        case 'interval':
            if (when.interval === 'every_week') return `Каждую неделю, ${weekDays[when.weekDay - 1]?.toLowerCase()} в ${when.time}`;
            if (when.interval === 'every_month') return `Каждый месяц, ${when.day}-го в ${when.time}`;
            if (when.interval === 'every_year') return `Каждый год, ${when.day} ${months[when.month - 1]?.toLowerCase()} в ${when.time}`;
            return `Ежедневно в ${when.time}`;
        case 'tg_message_received':
            return when.direction === 'incoming' ? 'При входящем сообщении Telegram'
                : when.direction === 'outgoing' ? 'При исходящем сообщении Telegram' : 'При сообщении в Telegram';
        case 'email_received':
            return when.direction === 'incoming' ? 'При входящем письме' : when.direction === 'outgoing' ? 'При исходящем письме' : 'При письме';
        default:
            return when.afterMinutes ? `${afterMinuteMap[when.afterMinutes] ?? `Через ${when.afterMinutes} мин`} после создания или перехода в этап` : 'Сразу после создания или перехода в этап';
    }
});

const employees = computed(() => props.users.filter((u) => u.role !== UserRole.CtrAgent));

const conditions = computed(() => {
    const data: DealFilter[] = [
        {label: 'Ответственный', field: 'agent_id', is_filler: false, value: ''},
        {label: 'Бюджет', field: 'budget', is_filler: false, value: ''}
    ];
    for (const filler of props.fillers) {
        data.push({ label: filler.field, field: filler.field, is_filler: true, value: '' });
    }
    return data;
});

function filterLabel(filter: DealFilter) {
    return filter.label || conditions.value.find((c) => c.field === filter.field && !!c.is_filler === !!filter.is_filler)?.label || filter.field;
}

function onFilterRemove(idx: number) {
    props.trigger.deal_filters.splice(idx, 1);
}

function closeWhenPicker() {
    whenPicker.value?.removeAttribute('open');
}

function validate(): string {
    const t = props.trigger as any;
    if (when.kind === 'at_exact_time' && !when.date) return 'Укажите дату';
    if ((when.kind === 'at_exact_time' || when.kind === 'interval') && !/^\d{2}:\d{2}$/.test(when.time)) return 'Укажите время';
    if (t.type === TriggerType.CreateDeal && !t.create_deal_data?.stage_id) return 'Выберите этап для новой сделки';
    if (t.type === TriggerType.SendEmail && !t.send_email_data?.template_id) return 'Выберите шаблон письма';
    if (t.type === TriggerType.ChangeAgent && !t.change_agent_data?.agent_id) return 'Выберите ответственного';
    if (t.type === TriggerType.ChangeFields && !t.change_fields_data?.fields?.length) return 'Добавьте хотя бы одно поле';
    if (t.type === TriggerType.CreateTask && !t.create_task_data?.type_id) return 'Выберите тип задачи';
    for (const f of props.trigger.deal_filters) if (!String(f.value ?? '').trim()) return `Заполните условие «${filterLabel(f)}»`;
    return '';
}

async function onTriggerSave() {
    error.value = validate();
    if (error.value) return;
    const values = toStageTrigger(props.trigger);
    const existing = props.stage.triggers.find((t) => t.id === props.trigger.id);
    if (existing) {
        // a saved trigger (PATCH on save) or a new one opened again: replace, never duplicate
        props.stage.triggers = props.stage.triggers.map((t) => t.id === props.trigger.id ? ({...t, ...values}) : t);
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
        label: dealFilter.value.label || ''
    });
});
</script>
<template>
    <div class="absolute bottom-0 translate-y-full bg-white border border-muted-200 rounded-md z-10 w-[32rem] max-w-[calc(100vw-2rem)] trigger-dropdown dark:bg-muted-800 dark:border-muted-700">
        <form @submit.prevent="onTriggerSave">
            <section class="bg-muted-100 p-3 dark:bg-muted-900 rounded-t-md">
                <span class="text-muted-700 text-sm dark:text-muted-200">
                    Для всех сделок у которых:
                </span>
                <ul v-if="trigger.deal_filters.length" class="flex flex-col gap-2 mb-2 mt-1">
                    <li v-for="(filter, idx) in trigger.deal_filters" :key="filter.field + idx" class="flex items-center gap-2">
                        <div class="border border-muted-200 rounded-md flex items-center flex-1 bg-white dark:bg-muted-900 dark:border-muted-700">
                            <span class="text-sm text-muted-700 ms-3 whitespace-nowrap dark:text-muted-200"> {{ idx >= 1 ? 'И ' : '' }}
                                {{ filterLabel(filter) }}
                            </span>
                            <BaseAutocomplete
                                v-if="filter.field === 'agent_id'"
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
                        <label class="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted-100 dark:hover:bg-muted-700">
                            <input type="radio" value="right_away" v-model="when.kind" class="accent-primary-600" />
                            <select v-model.number="when.afterMinutes" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200" @click="when.kind = 'right_away'">
                                <option v-for="(label, minutes) in afterMinuteMap" :key="minutes" :value="Number(minutes)">{{ label }}</option>
                            </select>
                            <span>после создания или перехода в этап</span>
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
                            <input type="radio" value="email_received" v-model="when.kind" class="accent-primary-600" />
                            <span>При</span>
                            <select v-model="when.direction" class="bg-transparent text-primary-600 underline underline-offset-2 outline-none dark:text-primary-200" @click="when.kind = 'email_received'">
                                <option value="incoming">входящем</option>
                                <option value="outgoing">исходящем</option>
                                <option value="any">любом</option>
                            </select>
                            <span>письме</span>
                        </label>
                        <div class="p-2 flex justify-end">
                            <BaseButton size="sm" type="button" @click="closeWhenPicker">Готово</BaseButton>
                        </div>
                    </div>
                </details>
            </section>
            <TaskTrigger v-if="trigger.type === TriggerType.CreateTask" :employees="employees" :trigger="trigger" />
            <EmailTrigger v-else-if="trigger.type === TriggerType.SendEmail" :trigger="trigger" :employees="employees" />
            <CloseTaskTrigger v-else-if="trigger.type === TriggerType.CloseTasks" :trigger="trigger" />
            <ChangeAgentTrigger v-else-if="trigger.type === TriggerType.ChangeAgent" :trigger="trigger" :employees="employees" />
            <DeleteFilesTrigger v-else-if="trigger.type === TriggerType.DeleteFiles" :trigger="trigger" />
            <ChangeFieldsTrigger v-else-if="trigger.type === TriggerType.ChangeFields" :trigger="trigger" :fillers="fillers" />
            <CreateDealTrigger v-else-if="trigger.type === TriggerType.CreateDeal" :trigger="trigger" :stage="stage" :stages="stages ?? []" />
            <p v-if="error" class="px-3 pb-2 text-sm text-rose-600">{{ error }}</p>
            <div class="flex items-center justify-between px-3 pb-3">
                <div class="flex gap-2">
                    <BaseButton variant="solid" color="primary" size="sm" type="submit">Готово</BaseButton>
                    <BaseButton variant="pastel" color="default" size="sm" @click="emits('cancel')">Отменить</BaseButton>
                </div>
                <BaseButtonIcon size="sm" color="danger" type="button" v-if="trigger.id > 0" @click="emits('remove', trigger)">
                    <Icon name="ph:trash" class="size-4" />
                </BaseButtonIcon>
            </div>
        </form>
        <TriggerRuns v-if="trigger.id > 0 && stage.id > 0" :stage-id="stage.id" :trigger-id="trigger.id" />
    </div>
</template>
