<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Аналитика по событиям</h1>
            <h2 class="text-sm text-gray-500">Список событий</h2>
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
                            <form class="flex items-start flex-col gap-2 w-full px-2 overflow-hidden" @submit.prevent="fetchLogs">
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
                                    placeholder="Типы событий" 
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

const eventTypes: Entity<number>[] = [
    {
        id: DealEventType.NewDeal,
        label: 'Новая сделка'
    },
    {
        id: DealEventType.NewComment,
        label: 'Новое примечание'
    },
    {
        id: DealEventType.NewChatMessage,
        label: 'Внутренное сообщение'
    },
    {
        id: DealEventType.NewCompany,
        label: 'Новая компания'
    },
    {
        id: DealEventType.NewCtrAgent,
        label: 'Новая контакт'
    },
    {
        id: DealEventType.NewSMS,
        label: 'Новый СМС'
    },
    {
        id: DealEventType.NewTask,
        label: 'Новая задача'
    },
    {
        id: DealEventType.NewCallRecording,
        label: 'Новое голосове'
    },
    {
        id: DealEventType.NewTaskStatus,
        label: 'Результат по задаче'
    },
    {
        id: DealEventType.NewTelegramCall,
        label: 'Новый телеграм звонок'
    },
    {
        id: DealEventType.NewEmail,
        label: 'Новое письмо'
    },
    {
        id: DealEventType.NewFieldValue,
        label: 'Новое значение'
    },
    {
        id: DealEventType.NewUpdatedFieldValue,
        label: 'Изменения поля'
    },
    {
        id: DealEventType.NewTelegramMessage,
        label: 'Новое телеграм сообщение'
    },
    {
        id: DealEventType.NewProduct,
        label: 'Новый товар'
    },
];

const initialFilters: Filters = {
    originatedBy: undefined,
    dates: [],
    entities: [],
    types: eventTypes,
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
const sortBy = ref<Record<string, any>>({createdAt: -1});
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


const today = [moment().subtract(1, 'day').format('YYYY-MM-DD'), moment().add(1, 'day').format('YYYY-MM-DD')];
const yesterday = [moment().subtract(2, 'day').format('YYYY-MM-DD'), moment().format('YYYY-MM-DD')];
const last30Days = [moment().subtract(31, 'day').format('YYYY-MM-DD'), moment().add(1, 'day').format('YYYY-MM-DD')];
const presetDates = ref([
    { label: 'За сегодня', value: today },
    { label: 'За вчера', value: yesterday },
    { label: 'За последние 30 дней', value: last30Days },
    { label: 'За эту неделю', value: [moment().startOf('week'), moment().endOf('week')] },
    { label: 'За прошлую неделю', value: [moment().subtract(1, 'week').startOf('week'), moment().subtract(1, 'week').endOf('week')] },
    { label: 'За этот месяц', value: [moment().startOf('month'), moment().endOf('month')] },
    { label: 'За прошлый месяц', value: [moment().subtract(1, 'month').startOf('month'), moment().subtract(1, 'month').endOf('month')] },
    { label: 'За квартал', value: [moment().startOf('quarters'), moment().endOf('quarters')] },
    { label: 'За этот год', value: [moment().startOf('year'), moment().endOf('year')] },
]);

const eventTypeNameMap: Record<DealEventType, (event: DealEvent) => string> = {
    [DealEventType.NewDeal]: () => 'Новая сделка',
    [DealEventType.NewComment]: () => 'Новое примечание',
    [DealEventType.NewChatMessage]: () => 'Внутренное сообщение',
    [DealEventType.NewCompany]: () => 'Новая компания',
    [DealEventType.NewCtrAgent]: () => 'Новый контакт',
    [DealEventType.NewSMS]: () => 'Новый СМС',
    [DealEventType.NewTask]: () => 'Новая задача',
    [DealEventType.NewCallRecording]: () => 'Новое голосовое',
    [DealEventType.NewTaskStatus]: () => 'Результат по задаче',
    [DealEventType.NewTelegramCall]: () => 'Новый телеграм звонок',
    [DealEventType.NewEmail]: () => 'Новая почта',
    [DealEventType.NewFieldValue]: (event: DealEvent) => event.type === DealEventType.NewFieldValue ?  `Новое значения для "${event.after_state.data.field}"` : '',
    [DealEventType.NewUpdatedFieldValue]: (event: DealEvent) => event.type === DealEventType.NewUpdatedFieldValue ? `Изменено поле "${event.after_state.data.field}"` : '',
    [DealEventType.NewTelegramMessage]: () => 'Новое телеграм сообщение',
    [DealEventType.NewProduct]: () => 'Новый товар',
    [DealEventType.NewStage]: () => 'Новый этап',
};

const objectNameMap: Record<DealEventType, (event: DealEvent) => string> = {
    [DealEventType.NewDeal]: () => 'Сделка',
    [DealEventType.NewComment]: () => 'Сделка',
    [DealEventType.NewChatMessage]: () => 'Сделка',
    [DealEventType.NewCompany]: () => 'Компания',
    [DealEventType.NewCtrAgent]: () => 'Контакт',
    [DealEventType.NewSMS]: () => 'Сделка',
    [DealEventType.NewTask]: () => 'Задача',
    [DealEventType.NewCallRecording]: () => 'Сделка',
    [DealEventType.NewTaskStatus]: () => 'Сделка',
    [DealEventType.NewTelegramCall]: () => 'Сделка',
    [DealEventType.NewEmail]: () => 'Сделка',
    [DealEventType.NewFieldValue]: () => 'Сделка',
    [DealEventType.NewUpdatedFieldValue]: () => 'Сделка',
    [DealEventType.NewTelegramMessage]: () => 'Сделка',
    [DealEventType.NewProduct]: () => 'Сделка',
    [DealEventType.NewStage]: () => 'Сделка',
};

const normalized = computed(() => {
    const results: NormalizeEvent[] = [];
    for (const log of logs.value.data) {
        let result: NormalizeEvent = {
            created_at: log.created_at,
            author: log.originated_by.username,
            object: objectNameMap[log.type]?.(log),
            name: '',
            event: eventTypeNameMap[log.type]?.(log),
            value_before: '',
            value_after: '',
            link: ''
        };
        switch (log.type) {
            case DealEventType.NewProduct: {
                result.name = log.after_state.data.product.name;
                result.link = `/lists/products/${log.after_state.data.product.id}`;
            } break;
            case DealEventType.NewDeal: {
                result.name = log.after_state.data.label;
                result.link = `/deals/${log.after_state.data.id}`;
            } break;
            case DealEventType.NewComment: {
                result.value_after = log.after_state.data.comment;
                if (log.deal) {
                    result.name = log.deal.label;
                    result.link = `/deals/${log.deal.id}`;
                }
            } break;
            case DealEventType.NewCtrAgent: {
                result.name = log.after_state.data.username;
                result.link = `/lists/contacts/${log.after_state.data.id}`;
            } break;
            case DealEventType.NewCompany: {
                result.name = log.after_state.data.name;
                result.link = `/lists/companies/${log.after_state.data.id}`;
            } break;
            case DealEventType.NewEmail: {
                result.name = log.after_state.data.subject;
                result.link = `/mails/${log.after_state.data.id}`;
            } break;
            case DealEventType.NewChatMessage: {
                result.value_after = log.after_state.data.message;
                if (log.deal) {
                    result.name = log.deal.label;
                    result.link = `/deals/${log.deal.id}`;
                }
            } break;
            case DealEventType.NewFieldValue: {
                result.value_after = log.after_state.data.new_value;
                if (log.deal) {
                    result.name = log.deal.label;
                    result.link = `/deals/${log.deal.id}`;
                }
            } break;
            case DealEventType.NewUpdatedFieldValue: {
                result.value_after = log.after_state.data.new_value;
                result.value_before = log.after_state.data.old_value;
                if (log.deal) {
                    result.name = log.deal.label;
                    result.link = `/deals/${log.deal.id}`;
                }
            } break;
            case DealEventType.NewStage: {
                result.value_after = log.after_state.data.stage.name;
                result.value_before = log.after_state.data.stage.name;
                if (log.deal) {
                    result.name = log.deal.label;
                    result.link = `/deals/${log.deal.id}`;
                }
            } break;
            case DealEventType.NewTask: {
                result.name = log.after_state.data.deal?.label || log.after_state.data.ctr_agent?.username || log.after_state.data.company?.name || '';
                result.value_after = log.after_state.data.label;
                result.link = `/tasks?id=${log.after_state.data.id}`;
            } break;
            case DealEventType.NewTaskStatus: {
                result.name = log.after_state.data.deal?.label || log.after_state.data.ctr_agent?.username || log.after_state.data.company?.name || '';
                result.value_after = log.after_state.data.result || '';
                result.link = `/tasks?id=${log.after_state.data.id}`;
            } break;
            case DealEventType.NewTelegramCall: {
                if (log.deal) {
                    result.name = log.deal.label;
                    result.link = `/deals/${log.deal.id}`;
                }
            } break;
            case DealEventType.NewTelegramMessage: {
                result.value_after = log.after_state.message;
                if (log.deal) {
                    result.name = log.deal.label;
                    result.link = `/deals/${log.deal.id}`;
                }
            } break;
            case DealEventType.NewCallRecording: {
                if (log.deal) {
                    result.name = log.deal.label;
                    result.link = `/deals/${log.deal.id}`;
                }
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
        dateFormat: 'MMM Do, HH:mm',
        link: (e: NormalizeEvent) => e.link,
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
        field: (event: DealEvent) => {
            if (event.type === DealEventType.NewUpdatedFieldValue) {
                return event.after_state.data.old_value;
            }
        }
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
    fetchLogs();
    close();
}

function fetchLogs() {
    const query: Record<string, any> = {
        limit: perPage.value,
        skip: (currentPage.value - 1) * perPage.value,
        sort: { id: -1 },
    };

    if (filters.dates?.length === 2) {
        query.created_before = filters.dates[1];
        query.created_after = filters.dates[0];
    }

    if (filters.entities.length) {
        query.entities = filters.entities.map((e) => e.id);
    }

    if (filters.types.length) {
        query.types = filters.types.map((t) => t.id);
    }

    if (filters.originatedBy?.id) {
        query.originated_by = filters.originatedBy.id;
    }

    run(logService.find(query).exec());
}

watch([currentPage, perPage], fetchLogs);

onMounted(() => {
    fetchLogs();
    runUsers(userService.find({limit: 1000}).exec());
});

</script>

<style>
</style>
