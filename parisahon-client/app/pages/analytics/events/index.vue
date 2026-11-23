<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Аналитика по событиям</h1>
            <h2 class="text-sm text-gray-500">Список событий</h2>
            <!-- /analytics/events?deal_id=12: the history of one deal -->
            <p v-if="dealId" class="mt-2 flex items-center gap-2 text-sm text-muted-600 dark:text-muted-300">
                <span>Только сделка № {{ dealId }}</span>
                <BaseButton size="sm" @click="dealId = null">Все сделки</BaseButton>
            </p>
        </div>
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex items-center gap-4">
                <DateSelect
                    v-model:start="dateFilter.start"
                    v-model:end="dateFilter.end"
                    label="Дата создания"
                />
                <PerPageSelect v-model="perPage" />
                <TairoPopover fixed size="2md">
                    <BaseButton><Icon name="ph:funnel" /></BaseButton>
                    <template #content={close}>
                        <div class="flex gap-4 p-4">
                            <section class="max-w-[16rem] w-full">
                                <ul class="flex flex-col gap-1">
                                    <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.All" v-model="preset" :id="'preset-' + Preset.All" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)" checked>
                                        <label :for="'preset-' + Preset.All" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 dark:hover:text-primary-200 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            Все события 
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.Mine" v-model="preset" :id="'preset-' + Preset.Mine" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)">
                                        <label :for="'preset-' + Preset.Mine" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 dark:hover:text-primary-200 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            Только мои события 
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.Today" v-model="preset" :id="'preset-' + Preset.Today" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)">
                                        <label :for="'preset-' + Preset.Today" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 dark:hover:text-primary-200 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            События за сегодня
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.Yesterday" v-model="preset" :id="'preset-' + Preset.Yesterday" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)">
                                        <label :for="'preset-' + Preset.Yesterday" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 dark:hover:text-primary-200 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            События за вчера
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.Month" v-model="preset" :id="'preset-' + Preset.Month" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)">
                                        <label :for="'preset-' + Preset.Month" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 dark:hover:text-primary-200 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            События за месяц
                                        </label>
                                    </li>
                                </ul>
                            </section>
                            <form class="flex items-start flex-col gap-2 w-full px-2 overflow-hidden" @submit.prevent="onFiltersApply(close)">
                                <DatePicker 
                                    v-model="filters.dates"
                                    format="dd-MM-yyyy" 
                                    range text-input vertical 
                                    :preset-dates="presetDates" 
                                    auto-apply 
                                    :enable-time-picker="false"
                                    model-type="yyyy-MM-dd"
                                    :teleport="true"
                                    :dark="isDarkMode"
                                >
                                    <template #dp-input="{ onInput, value, onBlur, onPaste }">
                                        <BaseInput :value="value" @input="onInput" @blur="onBlur" @paste="onPaste" placeholder="За все время" />
                                    </template>
                                </DatePicker>
                                <BaseAutocomplete 
                                    placeholder="Менеджеры" 
                                    :fixed="true" 
                                    :items="employees" 
                                    :properties="{label: 'username', value: 'id', sublabel: (u: User)  => u.group?.name}" 
                                    dropdown 
                                    v-model="filters.originatedBy"
                                    clearable
                                />
                                <BaseListbox 
                                    :items="entities" 
                                    :properties="{label: 'label', value: 'id' }"
                                    multiple 
                                    :fixed="true"
                                    placeholder="Сущности: все значения" 
                                    :multipleLabel="(value, prop) => {
                                        if (!value.length) return;
                                        else return `${value.map(v => v[prop]).join(', ')}`;
                                    }"
                                    v-model="filters.entities"
                                />
                                <BaseListbox 
                                    :items="eventTypes" 
                                    :properties="{label: 'label', value: 'id' }"
                                    multiple 
                                    :fixed="true"
                                    placeholder="Типы событий: все значения" 
                                    :multipleLabel="(value, prop) => {
                                        if (!value.length) return;
                                        else return `${value.map(v => v[prop]).join(', ')}`;
                                    }"
                                    v-model="filters.types"
                                />
                                <BaseButton type="submit">Применить</BaseButton>
                            </form>
                        </div>
                    </template>
                </TairoPopover>
            </div>
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="normalized"
                :loading="isLoading"
                class="flex-auto"
                id="events"
            >
            </BaseTable>
            <BasePagination
                v-if="logs.count / perPage > 1"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="logs.count"
                :max-links-displayed="10"
                shape="rounded"
            />
        </div>
    </div>
</template>

<script lang="ts" setup>
import DatePicker from '@vuepic/vue-datepicker';
import moment from 'moment';

import BaseTable from '~/components/common/BaseTable.vue';
import DateSelect from '~/components/common/DateSelect.vue';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import { type Column } from '~/components/common/types';
import TairoPopover from '~/components/tairo/TairoPopover.vue';
import { type DealEvent,DealEventType } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';
import { type User,UserRole } from '~/types/user';
import { EVENT_MOVED, EVENT_TASK_UPDATE, durationOf, fieldLabel, fieldValue, isOutgoing, personName, taskChanges } from '~/components/common/feed';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Список событий'
});

useHead({
    title: 'Список событий'
});

enum Preset {
    All = 'all',
    Mine = 'mine',
    Today = 'today',
    Yesterday = 'yesterday',
    Month = 'month'
} 

type Entity<T> = {
    id: T;
    label: string;
}

type Filters = {
    originatedBy?: User;
    dates?: string[];
    entities: Entity<string>[];
    types: Entity<number>[];
}

type NormalizeEvent = {
    created_at: string;
    author: string;
    object: string;
    name: string;
    event: string;
    value_before: string;
    value_after: string;
    link: string;
} 

// the types of the history (src/events/event.entity.ts); 17 and 18 have no member in DealEventType yet
const eventTypes: Entity<number>[] = [
    { id: DealEventType.NewDeal, label: 'Новая сделка' },
    { id: DealEventType.NewStage, label: 'Смена этапа' },
    { id: DealEventType.NewComment, label: 'Примечание' },
    { id: DealEventType.NewChatMessage, label: 'Внутреннее сообщение' },
    { id: DealEventType.NewCompany, label: 'Компания в сделке' },
    { id: DealEventType.NewCtrAgent, label: 'Контакт в сделке' },
    { id: DealEventType.NewSMS, label: 'СМС' },
    { id: DealEventType.NewTask, label: 'Новая задача' },
    { id: EVENT_TASK_UPDATE, label: 'Задача изменена' },
    { id: DealEventType.NewTaskStatus, label: 'Задача выполнена' },
    { id: DealEventType.NewCallRecording, label: 'Звонок' },
    { id: DealEventType.NewTelegramCall, label: 'Звонок в Telegram' },
    { id: DealEventType.NewEmail, label: 'Письмо' },
    { id: DealEventType.NewFieldValue, label: 'Новое значение поля' },
    { id: DealEventType.NewUpdatedFieldValue, label: 'Изменение поля' },
    { id: DealEventType.NewTelegramMessage, label: 'Сообщение Telegram' },
    { id: DealEventType.NewWhatsAppMessage, label: 'Сообщение WhatsApp' },
    { id: DealEventType.NewProduct, label: 'Новый товар' },
    { id: EVENT_MOVED, label: 'Перенос в другую сделку' },
];
const typeLabel = new Map(eventTypes.map((t) => [t.id, t.label]));

// no type chosen = every type (new types too): the filter is not sent
const initialFilters: Filters = {
    originatedBy: undefined,
    dates: [],
    entities: [],
    types: [],
};

const route = useRoute();
const app = useAppConfig();
const logService = useService('logs', {auth: true});
const userService = useService('users', {auth: true});
const filters = reactive<Filters>({...initialFilters});
const user = useState<User>('user');

const preset = ref<Preset>(Preset.All);
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const dateFilter = reactive({start: '', end: ''});
// one deal's history (the API filters by deal_id)
const dealId = ref<number | null>(Number(route.query.deal_id) > 0 ? Number(route.query.deal_id) : null);
// the date column sorts on the server (newest first by default)
const sortBy = ref<Record<string, any>>({created_at: -1});
const { run, data: logs, isLoading } = useAsync<{
    count: number, data: DealEvent[], page_size: number, current_page: number, last_page: 0}
>(
    { data: [], count: 0, last_page: 0, current_page: 0 }
);

const isDarkMode = useDarkMode();

const { run: runUsers, data: users } = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});

const entities = ref<Entity<string>[]>([
    {
        id: 'company',
        label: 'Компании'
    },
    {
        id: 'deal',
        label: 'Сделки'
    },
    {
        id: 'user',
        label: 'Пользователи'
    }
]);

// periods are inclusive days: «за сегодня» is today only (it was yesterday and today, AUDIT-10)
const day = (value: moment.MomentInput) => moment(value).format('YYYY-MM-DD');
const today = [day(moment()), day(moment())];
const yesterday = [day(moment().subtract(1, 'day')), day(moment().subtract(1, 'day'))];
const last30Days = [day(moment().subtract(29, 'day')), day(moment())];
const presetDates = ref([
    { label: 'За сегодня', value: today },
    { label: 'За вчера', value: yesterday },
    { label: 'За последние 30 дней', value: last30Days },
    { label: 'За эту неделю', value: [day(moment().startOf('week')), day(moment().endOf('week'))] },
    { label: 'За прошлую неделю', value: [day(moment().subtract(1, 'week').startOf('week')), day(moment().subtract(1, 'week').endOf('week'))] },
    { label: 'За этот месяц', value: [day(moment().startOf('month')), day(moment().endOf('month'))] },
    { label: 'За прошлый месяц', value: [day(moment().subtract(1, 'month').startOf('month')), day(moment().subtract(1, 'month').endOf('month'))] },
    { label: 'За квартал', value: [day(moment().startOf('quarter')), day(moment().endOf('quarter'))] },
    { label: 'За этот год', value: [day(moment().startOf('year')), day(moment().endOf('year'))] },
]);

const objectNameMap: Record<number, (event: DealEvent) => string> = {
    [DealEventType.NewCompany]: () => 'Компания',
    [DealEventType.NewCtrAgent]: () => 'Контакт',
    [DealEventType.NewTask]: () => 'Задача',
    [EVENT_TASK_UPDATE]: () => 'Задача',
    [DealEventType.NewTaskStatus]: () => 'Задача',
};

/** The name of the event: the type; for a field its label («Бюджет», «Компания · ИНН»). */
function eventName(log: any): string {
    if (log.type === DealEventType.NewFieldValue || log.type === DealEventType.NewUpdatedFieldValue) {
        return `${log.type === DealEventType.NewFieldValue ? 'Новое значение' : 'Изменено'}: ${fieldLabel(log.after_state?.data?.field, log.field_of, log.after_state?.data?.subject)}`;
    }
    if (log.type === DealEventType.NewCallRecording) {
        return isOutgoing(log) ? 'Исходящий звонок' : 'Входящий звонок';
    }
    if (log.type === DealEventType.NewEmail) {
        return isOutgoing(log) ? 'Исходящее письмо' : 'Входящее письмо';
    }
    return typeLabel.get(log.type) ?? 'Событие';
}

function short(text: unknown, max = 200): string {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

const normalized = computed(() => {
    const results: NormalizeEvent[] = [];
    for (const log of logs.value.data as any[]) {
        const data = log.after_state?.data ?? {};
        const result: NormalizeEvent = {
            created_at: log.created_at,
            // a deleted employee or contact is still the author (the page broke on null, AUDIT-7)
            author: personName(log.originated_by),
            object: objectNameMap[log.type]?.(log) ?? 'Сделка',
            name: '',
            event: eventName(log),
            value_before: '',
            value_after: '',
            link: ''
        };
        if (log.deal) {
            result.name = log.deal.label ?? '';
            result.link = `/deals/${log.deal.id}`;
        }
        switch (log.type) {
            case DealEventType.NewProduct: {
                result.value_after = [data.product?.name, data.quantity ? `${data.quantity} × ${data.price ?? ''}` : ''].filter(Boolean).join(', ');
            } break;
            case DealEventType.NewDeal: {
                result.name = data.label ?? result.name;
                if (data.id) result.link = `/deals/${data.id}`;
            } break;
            case DealEventType.NewComment: {
                result.value_after = short(data.comment);
            } break;
            case DealEventType.NewCtrAgent: {
                result.name = data.username ?? '';
                if (data.id) result.link = `/lists/contacts/${data.id}`;
            } break;
            case DealEventType.NewCompany: {
                result.name = data.name ?? '';
                if (data.id) result.link = `/lists/companies/${data.id}`;
            } break;
            case DealEventType.NewEmail: {
                result.value_after = data.subject ?? '';
            } break;
            case DealEventType.NewChatMessage: {
                result.value_after = short(data.message);
            } break;
            case DealEventType.NewFieldValue: {
                result.value_after = fieldValue(data.field, data.new_value, data.new_label);
            } break;
            case DealEventType.NewUpdatedFieldValue: {
                result.value_after = fieldValue(data.field, data.new_value, data.new_label);
                result.value_before = fieldValue(data.field, data.old_value, data.old_label);
            } break;
            case DealEventType.NewStage: {
                // the stage before is in before_state (the new stage was shown twice)
                result.value_after = data.stage?.name ?? '';
                result.value_before = log.before_state?.data?.stage?.name ?? '';
            } break;
            case DealEventType.NewTask:
            case EVENT_TASK_UPDATE:
            case DealEventType.NewTaskStatus: {
                if (!log.deal) result.name = data.deal?.label || data.ctr_agent?.username || data.company?.name || '';
                if (log.type === EVENT_TASK_UPDATE) {
                    result.value_before = log.before_state?.data?.label ?? '';
                    result.value_after = taskChanges(log.before_state?.data, data).join('; ') || data.label || '';
                } else {
                    result.value_after = log.type === DealEventType.NewTaskStatus ? (data.result || data.label || '') : (data.label ?? '');
                }
                if (data.id) result.link = `/tasks?id=${data.id}`;
            } break;
            case DealEventType.NewTelegramMessage:
            case DealEventType.NewWhatsAppMessage: {
                const state = log.after_state?.message !== undefined ? log.after_state : data;
                result.value_after = short(state?.message) || (state?.files?.length ? 'файл' : '');
            } break;
            case DealEventType.NewCallRecording:
            case DealEventType.NewTelegramCall: {
                result.value_after = durationOf(log.duration);
            } break;
            case EVENT_MOVED: {
                const to = data.to_deal;
                result.value_after = to ? `в сделку № ${to.display_id ?? to.id} «${to.label ?? ''}»` : '';
            } break;
        }

        results.push(result);
    }

    return results;
});

const columns = ref<Column[]>([
    {
        label: 'Дата',
        name: 'created_at',
        dateFormat: 'DD.MM.YYYY HH:mm',
        link: (e: NormalizeEvent) => e.link,
        sortable: true,
        resizable: true,
    },
    {
        label: 'Автор',
        name: 'author',
        link: (e: NormalizeEvent) => e.link,
        resizable: true,
    },
    {
        label: 'Объект',
        name: 'object',
        link: (e: NormalizeEvent) => e.link,
        classes(item) {
            return 'underline !text-blue-600';
        },
        resizable: true,
    },
    {
        label: 'Название',
        name: 'name',
        link: (e: NormalizeEvent) => e.link,
        resizable: true,
    },
    {
        label: 'Событие',
        name: 'event',
        link: (e: NormalizeEvent) => e.link,
        resizable: true,
        style: {
            overwrite: true,
            value: {
                'white-space': 'nowrap',
            }
        }
    },
    {
        label: 'Значение до',
        name: 'value_before',
        link: (e: NormalizeEvent) => e.link,
        resizable: true,
    },
    {
        label: 'Значение после',
        name: 'value_after',
        link: (e: NormalizeEvent) => e.link,
    },
]);

const employees = computed(() => {
    return users.value.data.filter((u) => u.role !== UserRole.CtrAgent);
});

function onPresetSelect(close: Function, e: Event) {
    const target = e.target as HTMLInputElement;
    const preset = target.value as Preset;
    const newFilters = {...initialFilters};
    switch (preset) {
        case Preset.All: {
        } break;
        case Preset.Mine: {
            newFilters.originatedBy = user.value;
        } break;
        case Preset.Yesterday: {
            newFilters.dates = yesterday;
        } break;
        case Preset.Today: {
            newFilters.dates = today;
        } break;
        case Preset.Month: {
            newFilters.dates = last30Days;
        } break;
    }

    Object.assign(filters, newFilters);
    currentPage.value = 1;
    fetchLogs();
    close();
}

function onFiltersApply(close: Function) {
    currentPage.value = 1;
    fetchLogs();
    close();
}

function fetchLogs() {
    const direction = Object.values(sortBy.value ?? {})[0] === 1 ? 1 : -1;
    const query: Record<string, any> = {
        limit: perPage.value,
        skip: (currentPage.value - 1) * perPage.value,
        sort: { created_at: direction },
    };

    // the first and the last day of the period, both included
    if (filters.dates?.length === 2 && filters.dates[0] && filters.dates[1]) {
        query.created_after = day(filters.dates[0]);
        query.created_before = day(filters.dates[1]);
    }

    if (filters.entities.length) {
        query.entities = filters.entities.map((e) => e.id);
    }

    // all types (or none) chosen: no filter, every type is listed
    if (filters.types.length && filters.types.length < eventTypes.length) {
        query.types = filters.types.map((t) => t.id);
    }

    if (filters.originatedBy?.id) {
        query.originated_by = filters.originatedBy.id;
    }

    if (dealId.value) {
        query.deal_id = dealId.value;
    }

    run(logService.find(query).exec());
}

// the period above the table is the same filter as the one in the panel (it was not read at all)
watch(() => [dateFilter.start, dateFilter.end], ([start, end]) => {
    filters.dates = start && end ? [day(start), day(end)] : [];
    currentPage.value = 1;
    fetchLogs();
});

watch([currentPage, perPage], fetchLogs);
watch(dealId, () => {
    currentPage.value = 1;
    fetchLogs();
});
watch(sortBy, () => {
    currentPage.value = 1;
    fetchLogs();
}, { deep: true });

onMounted(() => {
    fetchLogs();
    runUsers(userService.find({limit: 1000}).exec());
});

</script>

<style>
</style>
