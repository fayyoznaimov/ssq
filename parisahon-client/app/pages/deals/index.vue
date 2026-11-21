<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex flex-wrap items-center gap-4">
                <PerPageSelect v-model="perPage" />
                <div class="flex space-x-2 items-center">
                    <NuxtLink to="/deals?view=list" class="text-gray-300 dark:text-white" exact-active-class="text-gray-600">
                        <Icon
                            name="ph:list"
                            size="22"
                            class="text-inherit"
                        />
                    </NuxtLink>
                    <NuxtLink to="/deals?view=kanban" class="text-gray-300 dark:text-white" exact-active-class="text-gray-600">
                        <Icon
                            name="ph:kanban"
                            size="22"
                            class="text-inherit"
                        />
                    </NuxtLink>
                </div>
                <TairoPopover fixed size="2md">
                    <BaseButton><Icon name="ph:funnel" /></BaseButton>
                    <template #content={close}>
                        <div class="flex flex-col sm:flex-row gap-4 p-4">
                            <section class="sm:max-w-[16rem] w-full">
                                <ul class="flex flex-col gap-1">
                                    <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.All" v-model="preset" :id="'preset-' + Preset.All" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)" checked>
                                        <label :for="'preset-' + Preset.All" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            Все сделки 
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.Mine" v-model="preset" :id="'preset-' + Preset.Mine" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)">
                                        <label :for="'preset-' + Preset.Mine" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            Только мои сделки 
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.NoTask" v-model="preset" :id="'preset-' + Preset.NoTask" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)">
                                        <label :for="'preset-' + Preset.NoTask" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            Сделки без задач 
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.Overdue" v-model="preset" :id="'preset-' + Preset.Overdue" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)">
                                        <label :for="'preset-' + Preset.Overdue" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            С просреченными задачами 
                                        </label>
                                    </li>
                                </ul>
                            </section>
                            <form class="flex items-start flex-col gap-2 w-full px-2 overflow-hidden" @submit.prevent="applyFilters">
                                <ul class="w-full">
                                    <li>
                                        <details open v-animated-details>
                                            <summary class="uppercase text-xs font-medium py-2.5 cursor-pointer">
                                                Свойства сделок
                                            </summary>
                                            <ul class="flex flex-col gap-2 content">
                                                <li>
                                                    <BaseListbox 
                                                        :items="stages" 
                                                        :properties="{label: 'name', value: 'id' }"
                                                        multiple 
                                                        :fixed="true"
                                                        placeholder="Все этапы" 
                                                        :multipleLabel="(value, prop) => {
                                                            if (!value.length) return;
                                                            else return `${value.map(v => v[prop]).join(', ')}`;
                                                        }"
                                                        v-model="filters.stages"
                                                        name="stages"
                                                    />
                                                </li>
                                                <li>
                                                    <details v-animated-details>
                                                        <summary class="border border-muted-300 h-10 py-2 px-3 rounded-md text-sm text-muted-300 cursor-pointer dark:border-muted-700 dark:bg-muted-900" :class="[filters.dealDates?.length ? 'text-muted-600' : '']">
                                                            <template v-if="filters.dealDates?.length === 2">
                                                                <span v-if="filters.dealDateType === DealDateType.Created">Созданы: </span>
                                                                <span v-else-if="filters.dealDateType === DealDateType.Closed">Закрыты: </span>
                                                                <span>{{ filters.dealDates[0] }} - {{ filters.dealDates[1] }}</span>
                                                            </template>
                                                            <span v-else>За все время</span>
                                                        </summary>
                                                        <div class="content p-2 flex flex-col gap-2">
                                                            <ul class="flex gap-2 w-full">
                                                                <li class="flex-1">
                                                                    <input type="radio" id="deal-created" name="deal-date" value="created" v-model="filters.dealDateType" class="apperance-none opacity-0 h-0 absolute -z-10 peer" checked>
                                                                    <label for="deal-created" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel 
                                dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 
                                dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full">Созданы</label>
                                                                </li>
                                                                <li class="flex-1">
                                                                    <input type="radio" id="deal-closed" name="deal-date" value="closed" v-model="filters.dealDateType" class="apperance-none opacity-0 h-0 absolute -z-10 peer">
                                                                    <label for="deal-closed" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel 
                                dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 
                                dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full">Закрыты</label>
                                                                </li>
                                                            </ul>
                                                            <DatePicker 
                                                                format="dd-MM-yyyy" 
                                                                v-model="filters.dealDates" 
                                                                range text-input vertical 
                                                                :preset-dates="presetDates" 
                                                                auto-apply 
                                                                :enable-time-picker="false"
                                                                model-type="yyyy-MM-dd"
                                                                :teleport="true"
                                                                :dark="isDarkMode"
                                                            >
                                                                <template #dp-input="{ onInput, value, onBlur, onPaste }">
                                                                    <BaseInput :value="value" @input="onInput" @blur="onBlur" @paste="onPaste" placeholder="Выберите дату" name="deal_dates" />
                                                                </template>
                                                            </DatePicker>
                                                        </div>
                                                    </details>
                                                </li>
                                                <li>
                                                    <BaseAutocomplete 
                                                        placeholder="Ответственный" 
                                                        :fixed="true" 
                                                        :items="employees" 
                                                        :properties="{label: 'username', value: 'id', sublabel: (u: User)  => u.group?.name}" 
                                                        dropdown 
                                                        v-model="filters.agent"
                                                        name="agent"
                                                        clearable
                                                    />
                                                </li>
                                                <li>
                                                    <BaseListbox 
                                                        :items="taskFilters" 
                                                        :properties="{label: 'name', value: 'id' }"
                                                        multiple 
                                                        :fixed="true"
                                                        placeholder="Задачи: все значения" 
                                                        :multipleLabel="(value, prop) => {
                                                            if (!value.length) return;
                                                            else return `${value.map(v => v[prop]).join(', ')}`;
                                                        }"
                                                        v-model="filters.tasks"
                                                        name="task_filters"
                                                    />
                                                </li>
                                                <li class="flex gap-2 items-center">
                                                    <BaseInput type="text" inputmode="number" placeholder="Бюджет" v-model.lazy="filters.budgetFrom" name="budget_from" />
                                                    <span>-</span>
                                                    <BaseInput type="text" inputmode="number" name="budget_to" v-model.lazy="filters.budgetTill" />
                                                </li>
                                                <li v-for="filler in filters.dealFillers" :key="filler.id">
                                                    <BaseInput type="text" v-model="filler.value" :placeholder="filler.field" :name="'deal.fillers.' + filler.id" />
                                                </li>
                                            </ul>
                                        </details>
                                    </li>
                                    <li>
                                        <details v-animated-details>
                                            <summary class="uppercase text-xs font-medium py-2.5 cursor-pointer">
                                                Свойства контактов
                                            </summary>
                                            <ul class="flex flex-col gap-2 content">
                                                <li>
                                                    <BaseInput type="text" placeholder="Наименование" v-model.lazy="filters.ctrAgent.username" name="agent.username" />
                                                </li>
                                                <li>
                                                    <DatePicker 
                                                        v-model="filters.ctrAgent.dates"
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
                                                            <BaseInput :value="value" @input="onInput" @blur="onBlur" @paste="onPaste" placeholder="За все время" name="agent.dates" />
                                                        </template>
                                                    </DatePicker>
                                                </li>
                                                <li v-for="filler in filters.ctrAgent.fillers">
                                                    <BaseInput v-model="filler.value" :placeholder="filler.field" :name="'agent.fillers.' + filler.id"/>
                                                </li>
                                            </ul>
                                        </details>
                                    </li>
                                    <li>
                                        <details v-animated-details>
                                            <summary class="uppercase text-xs font-medium py-2.5 cursor-pointer">
                                                Свойства компаний
                                            </summary>
                                            <ul class="flex flex-col gap-2 content">
                                                <li>
                                                    <BaseInput type="text" placeholder="Наименование" v-model.lazy="filters.company.name" name="company.name" />
                                                </li>
                                                <li>
                                                    <DatePicker 
                                                        v-model="filters.company.dates"
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
                                                </li>
                                                <li v-for="filler in filters.company.fillers">
                                                    <BaseInput v-model="filler.value" :placeholder="filler.field" />
                                                </li>
                                            </ul>
                                        </details>
                                    </li>
                                </ul>
                                <BaseButton type="submit">Применить</BaseButton>
                            </form>
                        </div>
                    </template>
                </TairoPopover>
            </div>
            <div class="flex flex-wrap items-center gap-4">
                <Can I="delete" a="Deal">
                    <NuxtLink to="/deals/trash">
                        <BaseButton>
                            <Icon name="ph:trash" class="me-1.5 size-4" />
                            Корзина
                        </BaseButton>
                    </NuxtLink>
                </Can>
                <NuxtLink :to="'/settings/deals?from=' + route.href">
                    <BaseButton>
                        Настроить
                    </BaseButton>
                </NuxtLink>
                <Can I='create' a='Deal'>
                    <NuxtLink :to="'/deals/new?from=' + route.href">
                        <BaseButton color="primary">
                            Новая сделка
                        </BaseButton>
                    </NuxtLink>
                </Can>
            </div>
        </div>
        <div>
            <BaseInput
                v-model="label"
                icon="ph:list-magnifying-glass"
                placeholder="Поиск"
                size="lg"
            />
        </div>
        <div class="relative overflow-x-auto">
            <template v-if="route.query.view === 'kanban'">
                <transition :duration="300" name="stats">
                    <ul v-if="shouldRevealStats" class="flex flex-wrap gap-x-6 gap-y-2 justify-between bg-muted-200 py-2.5 px-4 rounded-md text-muted-700 dark:bg-muted-800 dark:text-muted-400">
                        <li class="flex flex-col">
                            <span class="text-sm">Задач на сегодня</span>
                            <span class="text-green-600 text-lg">{{ dealStats[0]?.task_count_for_today }}</span>
                        </li>
                        <li class="flex flex-col">
                            <span class="text-sm">Без задач</span>
                            <span class="text-yellow-600 text-lg">{{ dealStats[0]?.deals_without_tasks }}</span>
                        </li>
                        <li class="flex flex-col">
                            <span class="text-sm">Просроченные</span>
                            <span class="text-rose-500 text-lg">{{ dealStats[0]?.deals_with_overdue_tasks }}</span>
                        </li>
                        <li class="flex flex-col">
                            <span class="text-sm">Новых сегодня/вчера</span>
                            <span class="text-lg">{{ dealStats[0]?.new_deals_from_today }} / {{ dealStats[0]?.new_deals_from_yesterday }}</span>
                        </li>
                    </ul>
                </transition>
                <div>
                    <!-- on a phone a column is a bit narrower than the screen, so the next one peeks out -->
                    <ul class="flex gap-4 p-3 sm:p-6 rounded-sm overflow-x-auto dark:bg-muted-900" v-dragscroll="{ excluded: ['card-deal', 'add-deal-card'] }">
                        <li
                            v-for="(stage, idx) in sortedStages"
                            :key="stage.id"
                            class="basis-[calc(100%-3rem)] sm:basis-80 shrink-0"
                        >
                            <ProgressColumn
                                :stage-name="stage.name"
                                :stage="stage"
                                :is-create-deal="idx === 0"
                                :column-data="columnData[stage.id]"
                                v-model:dragging="dragging"
                                @stage:changed="onStageChange"
                                @deal:created="onDealCreated"
                            />
                        </li>
                    </ul>
                    <Draggable 
                        @add="onAdd" 
                        item-key="id"
                        :animation="200" 
                        ghost-class="ghost" 
                        class="hidden fixed bottom-0 transition-transform duration-300 max-w-7xl w-full" 
                        :class="{'-translate-y-16': dragging}"
                        :group="{name: 'cards', put: true, pull: false}" v-model="dealActions">
                        <template #item="{element}">
                            <div class="p-4 absolute w-full bg-muted-200 text-muted-900">{{ element.label }}</div>
                        </template>
                    </Draggable>
                </div>
            </template>
            <template v-else>
                <DealActionsNav
                    :selected="selectedDeals"
                    :totalAmount="totalAmount"
                    @update="fetchDeals"
                />
                <BaseTable
                    v-model:sortBy="sortBy"
                    v-model:selected="selectedDeals"
                    :columns="tableColumns"
                    :data="deals.data"
                    :loading="isLoading"
                    bulk-actions
                    :selector="(item) => item"
                    class="flex-auto mt-2"
                    id="deals"
                >
                    <template #client="{item}">
                        <ClientParts :deal="item" empty="—" class="block truncate text-sm" />
                    </template>
                    <template #actions="{item}">
                        <BaseButtonIcon size="sm" :to="{name: 'deals-id', params: {id: item.id}, query: {from: '/deals'}}">
                            <Icon
                                class="w-5 h-5"
                                name="ph:pencil-simple"
                            />
                        </BaseButtonIcon>
                    </template>
                </BaseTable>
            </template>
            <BasePagination
                v-if="deals.count / perPage > 1"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="deals.count"
                :max-links-displayed="10"
                shape="rounded"
            />
        </div>
    </div>
</template>

<script lang="ts" setup>
import { Can } from '@casl/vue';
import DatePicker from '@vuepic/vue-datepicker';
import moment from 'moment';
import Draggable from 'vuedraggable';

import BaseTable from '~/components/common/BaseTable.vue';
import DealActionsNav from '~/components/common/DealActionsNav.vue';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import ProgressColumn from '~/components/common/ProgressColumn.vue';
import {type Column} from '~/components/common/types';
import ClientParts from '~/components/deal/ClientParts.vue';
import TairoPopover from '~/components/tairo/TairoPopover.vue';
import {useAsync} from '~/composables/useAsync';
import type { Deal,DealStats,Stage } from '~/types/deal';
import type { Filler } from '~/types/filler';
import type { PaginatedResponse } from '~/types/generics';
import { type User,UserRole } from '~/types/user';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Сделки',
    subject: 'Deal'
});

useHead({
    title: 'Сделки'
});

enum Preset {
    All = 'all',
    Mine = 'mine',
    NoTask = 'no-task',
    Overdue = 'overdue'
} 

type TaskFilter = {
    id: string;
    name: string;
}

enum DealDateType {
    Created = 'created',
    Closed = 'closed'
}

type Filters = {
    agent?: User;
    stages: Stage[];
    tasks: TaskFilter[];
    dealDates?: string[];
    budgetFrom?: number;
    budgetTill?: number;
    dealFillers: (Filler & {value: string})[];
    ctrAgent: {
        username?: string;
        dates?: string[];
        fillers: (Filler & {value: string})[];
    };
    company: {
        name?: string;
        dates?: string[];
        fillers: (Filler & {value: string})[];
    };
    dealDateType: DealDateType;
}

const dealActions = [
    {
        label: 'Удалить',
        id: 'delete',
    }
];

const route = useRoute();
const app = useAppConfig();

const dragging = defineModel({ default: false });
const user = useState<User>('user');
const isDarkMode = useDarkMode();
const searchQ = ref({});
const selectedDeals = ref<Deal[]>([]);
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const dateFilter = reactive({start: '', end: ''});
const sortBy = ref<Record<string, any>>({id: -1});
const preset = ref<Preset>(Preset.All);
const shouldRevealStats = ref(false);

const initialFilters: Filters = {
    agent: undefined,
    stages: [],
    tasks: [],
    dealDates: [],
    budgetFrom: undefined,
    budgetTill: undefined,
    dealFillers: [],
    ctrAgent: {
        fillers: [],
        dates: []
    },
    company: {
        fillers: [],
        dates: []
    },
    dealDateType: DealDateType.Created
};

const filters = reactive<Filters>({
    ...initialFilters, 
    ...(route.query.stage_id && {stages: [{id: Number(route.query.stage_id), name: route.query.stage_name} as Stage]}),
    ...(route.query.user_id && {agent: {id: Number(route.query.user_id), username: route.query.username} as User}),
});

const label = ref();

const { run: runDealStats, data: dealStats, isLoading: dealStatsLoading } = useAsync<DealStats[]>([]);
const { run, isLoading, data: deals } = useAsync<{count: number, data: Deal[] }>({count: 0, data: []});
const { run: runStages, data: stages } = useAsync<Stage[]>([]);
const { run: runUsers, data: users } = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});

const { run: runFillers, data: fillers } = useAsync<{
    company: Filler[], 
    user: Filler[], 
    deal: Filler[],
    product: Filler[],
}>({ company: [], user: [], deal: [], product: [] });

const sortedStages = computed(() => stages.value.sort((a, b) => a.order - b.order));
const userService = useService('users', {auth: true});
const stagesService = useService('stages', {auth: true});
const dealsService = useService('deals', {auth: true});
const fillerService = useService('fillers', {auth: true});

const presetDates = ref([
    { label: 'За сегодня', value: [moment().startOf('day'), moment().startOf('day')] },
    { label: 'За вчера', value: [moment().subtract(1, 'day').startOf('day'), moment().subtract(1, 'day').startOf('day')] },
    { label: 'За последние 30 дней', value: [moment().subtract(30, 'day').startOf('day'), moment().startOf('day')] },
    { label: 'За эту неделю', value: [moment().startOf('week'), moment().endOf('week')] },
    { label: 'За прошлую неделю', value: [moment().subtract(1, 'week').startOf('week'), moment().subtract(1, 'week').endOf('week')] },
    { label: 'За этот месяц', value: [moment().startOf('month'), moment().endOf('month')] },
    { label: 'За прошлый месяц', value: [moment().subtract(1, 'month').startOf('month'), moment().subtract(1, 'month').endOf('month')] },
    { label: 'За квартал', value: [moment().startOf('quarters'), moment().endOf('quarters')] },
    { label: 'За этот год', value: [moment().startOf('year'), moment().endOf('year')] },
]);

const tableColumns = ref<Column[]>([
    {
        label: 'Название сделки',
        name: 'label',
        sortable: true,
        resizable: true,
    },
    {
        // name, phone and company of the client in their own colors, "повторный" for a repeat request
        label: 'Клиент',
        name: 'client',
        // the table fixes column widths by the header text; the client needs more room
        headerStyle: { width: '260px' },
        style: { value: { 'max-width': '320px' } },
    },
    {
        label: 'Этап сделки',
        name: 'stage',
        sortable: true,
        field: (item) => item.stage?.name,
        resizable: true,
    },
    {
        label: 'Бюджет',
        name: 'budget',
        money: true,
        sortable: true,
        field: (field) => Number(field.budget),
        resizable: true,
    },
    {
        label: 'Ответственный',
        name: 'agent',
        field: (field) => field.agent?.username,
        resizable: true,
    },
    {
        label: 'Дата создания',
        name: 'created_at',
        sortable: true,
        dateFormat: 'MMM Do, HH:mm'
    },
    {
        label: '',
        name: 'actions',
        headerStyle: {
            width: '100px'
        }
    }
]);

const noTask: TaskFilter = { id: 'no_task', name: 'Нет задач' };
const overdueTask: TaskFilter = { id: 'overdue', name: 'Просроченные' };

const taskFilters = ref<TaskFilter[]>([
    {
        id: 'today',
        name: 'На сегодня'
    },
    {
        id: 'tomorrow',
        name: 'На завтра'
    },
    {
        id: 'this_week',
        name: 'На этой неделе'
    },
    {
        id: 'this_month',
        name: 'На этом месяце'
    },
    {
        id: 'this_quarter',
        name: 'На этом квартале'
    },
    overdueTask,
    noTask,
]);

const totalAmount = computed(() => {
    let total = 0;
    if (!deals.value) return 0;
    for (let deal of selectedDeals.value) {
        total += Number(deal.budget);
    }
    return total;
});

const columnData = computed(() => {
    let data: Record<number, any> = {};
    for (let deal of deals.value?.data) {
        if (!deal.stage) continue;
        if (!data[deal.stage.id]) data[deal.stage.id] = [];
        data[deal.stage.id].push(deal);
    }

    return data;
});

const employees = computed(() => {
    return users.value.data.filter((u) => u.role !== UserRole.CtrAgent);
});

function onStageChange({id, stage}: { id: number, stage: Stage}) {
    deals.value = {...deals.value, data: deals.value.data.map((deal) => deal.id === id ? ({ ...deal, stage }) : deal)};
}

function onDealCreated(deal: Deal) {
    deals.value.data.push(deal);
    deals.value.count++;
}

function onAdd(added) {
}

// A preset starts from empty filters. Nested objects are cleared field by field:
// they are shared with `initialFilters`, so re-assigning them would keep the typed values.
function resetFilters() {
    filters.agent = undefined;
    filters.stages = [];
    filters.tasks = [];
    filters.dealDates = [];
    filters.dealDateType = DealDateType.Created;
    filters.budgetFrom = undefined;
    filters.budgetTill = undefined;
    filters.ctrAgent.username = undefined;
    filters.ctrAgent.dates = [];
    filters.company.name = undefined;
    filters.company.dates = [];
    for (const filler of [...filters.dealFillers, ...filters.ctrAgent.fillers, ...filters.company.fillers]) {
        filler.value = '';
    }
}

function onPresetSelect(close: Function, e: Event) {
    const target = e.target as HTMLInputElement;
    const preset = target.value as Preset;
    resetFilters();
    switch (preset) {
        case Preset.Mine: {
            filters.agent = user.value;
        } break;
        case Preset.NoTask: {
            filters.tasks = [noTask];
        } break;
        case Preset.Overdue: {
            filters.tasks = [overdueTask];
        } break;
    }

    close();
    applyFilters();
}

// New filters always start from the first page
function applyFilters() {
    if (currentPage.value !== 1) currentPage.value = 1; // the watcher below fetches
    else fetchDeals();
}

// Custom field filters as the API expects them: fillers[0][id]=..&fillers[0][value]=..
// (useService serialises an array of objects as `fillers[]=[object Object]`, an object with index keys is fine)
function fillerFilters(items: (Filler & {value: string})[]): Record<number, {id: number, value: string}> | undefined {
    const filled = items.filter((filler) => filler.value?.trim()).map((filler) => ({id: filler.id, value: filler.value.trim()}));
    if (!filled.length) return undefined;
    return Object.fromEntries(filled.map((filler, index) => [index, filler]));
}

function fetchStages() {
    runStages(stagesService.find().exec());
}

// The kanban has no pager: it asks for all deals (the API caps a page at 1000),
// the list keeps its page size.
const kanban = computed(() => route.query.view === 'kanban');

function fetchDeals() {
    const query: Record<string, any> = {
        limit: kanban.value ? 1000 : perPage.value,
        skip: kanban.value ? 0 : (currentPage.value - 1) * perPage.value,
        sort: sortBy.value,
    };

    if (filters.stages.length) {
        query.stages = filters.stages.map((s) => s.id);
    }

    if (filters.tasks.length) {
        query.tasks = filters.tasks.map((s) => s.id);
    }

    if (filters.dealDates?.length === 2) {
        if (filters.dealDateType === DealDateType.Created) {
            query.created_before = filters.dealDates[1];
            query.created_after = filters.dealDates[0];
        }

        if (filters.dealDateType === DealDateType.Closed) {
            query.closed_before = filters.dealDates[1];
            query.closed_after = filters.dealDates[0];
        }
    }

    if (label.value?.trim()) {
        query.label = label.value.trim();
    }

    if (filters.ctrAgent.username) {
        query.ctr_agent = {
            username: filters.ctrAgent.username,
        };
    }

    if (filters.company.name) {
        query.company = {
            name: filters.company.name,
        };
    }

    if (filters.ctrAgent.dates?.length === 2) {
        query.ctr_agent = {
            ...query.ctr_agent,
            created_before: filters.ctrAgent.dates[1],
            created_after: filters.ctrAgent.dates[0],
        };
    }

    if (filters.company.dates?.length === 2) {
        query.company = {
            ...query.company,
            created_before: filters.company.dates[1],
            created_after: filters.company.dates[0],
        };
    }

    const dealFillerFilters = fillerFilters(filters.dealFillers);
    const ctrAgentFillerFilters = fillerFilters(filters.ctrAgent.fillers);
    const companyFillerFilters = fillerFilters(filters.company.fillers);

    if (dealFillerFilters) {
        query.fillers = dealFillerFilters;
    }

    if (ctrAgentFillerFilters) {
        query.ctr_agent = {
            ...query.ctr_agent,
            fillers: ctrAgentFillerFilters,
        };
    }

    if (companyFillerFilters) {
        query.company = {
            ...query.company,
            fillers: companyFillerFilters,
        };
    }

    if (filters.agent?.id) {
        query.agent = {
            id: filters.agent.id
        }
    }

    if (filters.budgetFrom) {
        query.budget_from = filters.budgetFrom;
    }

    if (filters.budgetTill) {
        query.budget_till = filters.budgetTill;
    }

    // The API filters by created_after / created_before (createdAt[lt|gt] was ignored)
    if (dateFilter.end && dateFilter.start && !query.created_after && !query.created_before) {
        query.created_after = dateFilter.start;
        query.created_before = dateFilter.end;
    }

    runDealStats(dealsService.get('stats', query).exec());
    run(dealsService.find(query).exec());
}

watch(kanban, fetchDeals);
// live: deals created, moved or deleted elsewhere (others, triggers, Telegram, the bot);
// not while a card is being dragged — then right after the drop
let liveMissed = false;
useLive((changes) => {
    if (liveTouches(changes, 'stages')) fetchStages();
    if (!liveTouches(changes, 'deals') && !liveTouches(changes, 'tasks')) return;
    if (dragging.value) liveMissed = true;
    else fetchDeals();
}, 1000);
watch(dragging, (now) => {
    if (!now && liveMissed) {
        liveMissed = false;
        fetchDeals();
    }
});

// The search box is one more filter: it keeps the page size, the sorting and the other filters
const searchByLabel = debounce(() => applyFilters(), 300);

watch([
    currentPage, 
    sortBy, perPage, 
    searchQ, 
    dateFilter, 
], fetchDeals);
watch(label, searchByLabel);

watch(fillers, () => {
    const addFillers = (target: (Filler & {value: string})[], items?: Filler[]) => {
        for (const filler of items || []) {
            if (target.some((existing) => existing.id === filler.id)) continue;
            target.push({...filler, value: ''});
        }
    };

    addFillers(filters.dealFillers, fillers.value.deal);
    addFillers(filters.ctrAgent.fillers, fillers.value.user);
    addFillers(filters.company.fillers, fillers.value.company);
});

let lastScroll: undefined | number;

function onWheel(e: Event) {
    const doubleScrollTop = document.documentElement.scrollTop === 0 && lastScroll === document.documentElement.scrollTop;
    if (doubleScrollTop)  {
        shouldRevealStats.value = true;
    } else {
        shouldRevealStats.value = false;
    }

    lastScroll = document.documentElement.scrollTop;
}

onMounted(() => {
    fetchDeals();
    fetchStages();
    runUsers(userService.find({limit: 1000}).exec());
    runFillers(fillerService.find().exec());
    document.addEventListener('wheel', onWheel, {passive: true});
});

onUnmounted(() => {
    document.removeEventListener('wheel', onWheel);
});
</script>

<style scoped>
.ghost {
    opacity: 0.5;
}

.stats-enter-active,
.stats-leave-active {
    transition: all 0.3s ease-in-out;
}

.stats-enter-from,
.stats-leave-to {
    transform: translateY(-100%);
    opacity: 0;
}
</style>