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
                                            С просроченными задачами 
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
                                                    <!-- the budget is a number: the fields keep digits only -->
                                                    <BaseInput type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Бюджет от" v-model="filters.budgetFrom" name="budget_from" @input="onlyDigits('budgetFrom', $event)" />
                                                    <span>-</span>
                                                    <BaseInput type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="до" name="budget_to" v-model="filters.budgetTill" @input="onlyDigits('budgetTill', $event)" />
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
            <!-- one box: the number, the name, the client's name, phone or e-mail, the company -->
            <BaseInput
                v-model="label"
                icon="ph:list-magnifying-glass"
                placeholder="Поиск: номер, название, клиент, телефон, компания"
                size="lg"
            />
        </div>
        <div class="relative overflow-x-auto">
            <!-- the last request of the list failed: the deals on the screen are the previous ones -->
            <div
                v-if="listError"
                role="alert"
                class="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200"
            >
                <Icon name="ph:warning-circle" class="size-5 shrink-0" />
                <span class="min-w-0 flex-1">Список не обновлён: {{ listError }}. Показаны прежние данные.</span>
                <BaseButton size="sm" @click="fetchDeals({ notify: true })">Повторить</BaseButton>
            </div>
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
                    <BasePlaceload v-show="boardLoading" class="h-2 w-full" />
                    <!-- on a phone a column is a bit narrower than the screen, so the next one peeks out;
                         a column counts its deals on the server and loads its cards page by page -->
                    <ul class="flex gap-4 p-3 sm:p-6 rounded-sm overflow-x-auto dark:bg-muted-900" v-dragscroll="{ excluded: ['card-deal', 'add-deal-card', 'board-more'] }">
                        <li
                            v-for="(stage, idx) in sortedStages"
                            :key="stage.id"
                            class="basis-[calc(100%-3rem)] sm:basis-80 shrink-0"
                        >
                            <ProgressColumn
                                :stage-name="stage.name"
                                :stage="stage"
                                :is-create-deal="idx === 0"
                                :column-data="board.columns[stage.id]?.deals ?? []"
                                :total="board.columns[stage.id]?.count ?? 0"
                                :budget="board.columns[stage.id]?.budget ?? 0"
                                :loading-more="board.columns[stage.id]?.loading ?? false"
                                :closed-since="stage.is_closing ? board.closedSince : null"
                                v-model:dragging="dragging"
                                @stage:changed="onStageChange"
                                @deal:created="onDealCreated"
                                @load-more="loadMore(stage)"
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
                    :row-link="dealRoute"
                    class="flex-auto mt-2"
                    id="deals"
                >
                    <template #label="{item}">
                        <span class="font-medium text-muted-900 hover:text-primary-600 hover:underline dark:text-white">{{ item.label || 'Сделка №' + (item.display_id ?? item.id) }}</span>
                    </template>
                    <template #client="{item}">
                        <ClientParts :deal="item" empty="—" class="block truncate text-sm" />
                    </template>
                    <template #actions="{item}">
                        <BaseButtonIcon size="sm" :to="dealRoute(item)">
                            <Icon
                                class="w-5 h-5"
                                name="ph:pencil-simple"
                            />
                        </BaseButtonIcon>
                    </template>
                </BaseTable>
            </template>
            <BasePagination
                v-if="!kanban && deals.count / perPage > 1"
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
    budgetFrom?: string;
    budgetTill?: string;
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
const { run, isLoading, data: deals, error: dealsError } = useAsync<{count: number, data: Deal[] }>({count: 0, data: []});
// why the last request of the list failed ("" — it did not)
const listError = ref('');
const toast = useToast('GlobalToast');
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
        rowAnchor: true,
    },
    {
        // name, phone and company of the client in their own colors, "повторный" for a repeat request
        label: 'Клиент',
        name: 'client',
        // the table fixes column widths by the header text; the client needs more room
        headerStyle: { width: '260px' },
        style: { value: { 'max-width': '320px' } },
        rowAnchor: true,
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

// a row opens its deal; the name and the client are real links (a new tab, a copied address)
const dealRoute = (deal: Deal) => ({name: 'deals-id', params: {id: deal.id}, query: {from: '/deals'}});

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

// The kanban (GET /deals/board): every column has its totals counted by the server over all its deals
// and the cards loaded so far, newest first. The closing columns show the deals closed lately.
type BoardColumn = { deals: Deal[]; count: number; budget: number; loading: boolean };
type BoardTotal = { stage_id: number | null; count: number; budget: string; closing: boolean };
type BoardResponse = { stages: BoardTotal[]; data: Deal[]; per_stage: number; closed_since: string | null };

const BOARD_PAGE = 50;
const board = reactive<{ columns: Record<number, BoardColumn>; closedSince: string | null; loaded: boolean }>({
    columns: {},
    closedSince: null,
    loaded: false,
});
const boardLoading = ref(false);
// a full reload of the board started: answers of the older requests are dropped
let boardSeq = 0;

const newColumn = (): BoardColumn => ({ deals: [], count: 0, budget: 0, loading: false });
const budgetOf = (deal: Deal) => Number(deal.budget) || 0;

function columnOf(stageId: number): BoardColumn {
    board.columns[stageId] ??= newColumn();
    return board.columns[stageId];
}

// a card among the cards of its column (newest first); `complete`: the column had all its cards
function insertCard(deal: Deal, complete = true) {
    const stageId = deal.stage?.id;
    if (stageId == null) return;
    const column = columnOf(stageId);
    if (column.deals.some((item) => item.id === deal.id)) return;
    const last = column.deals[column.deals.length - 1];
    // older than the last card shown: it comes with «Показать ещё»
    if (!complete && last && deal.id < last.id) return;
    const at = column.deals.findIndex((item) => item.id < deal.id);
    if (at === -1) column.deals.push(deal);
    else column.deals.splice(at, 0, deal);
}

function applyTotals(stages: BoardTotal[]) {
    const seen = new Set<number>();
    for (const total of stages) {
        if (total.stage_id == null) continue;
        seen.add(total.stage_id);
        const column = columnOf(total.stage_id);
        column.count = total.count;
        column.budget = Number(total.budget) || 0;
    }
    for (const [id, column] of Object.entries(board.columns)) {
        if (seen.has(Number(id))) continue;
        column.count = 0;
        column.budget = 0;
        column.deals = [];
    }
}

function applyBoard(data: BoardResponse) {
    board.columns = {};
    applyTotals(data.stages);
    for (const deal of data.data) insertCard(deal);
    board.closedSince = data.closed_since;
    board.loaded = true;
}

const employees = computed(() => {
    return users.value.data.filter((u) => u.role !== UserRole.CtrAgent);
});

// a card dragged to another column (or back, when the server refused the move)
function onStageChange({id, stage}: { id: number, stage: Stage}) {
    let moved: Deal | undefined;
    for (const column of Object.values(board.columns)) {
        const at = column.deals.findIndex((deal) => deal.id === id);
        if (at === -1) continue;
        moved = column.deals[at];
        column.deals.splice(at, 1);
        column.count = Math.max(0, column.count - 1);
        column.budget -= budgetOf(moved);
    }
    if (!moved) return;
    const card = { ...moved, stage };
    insertCard(card);
    const target = columnOf(stage.id);
    target.count++;
    target.budget += budgetOf(card);
}

// «Быстрое добавление» in the first column
function onDealCreated(deal: Deal) {
    if (!deal.stage?.id) return;
    const column = columnOf(deal.stage.id);
    if (column.deals.some((item) => item.id === deal.id)) return;
    column.deals.unshift(deal);
    column.count++;
    column.budget += budgetOf(deal);
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

// The budget filter takes digits only: the field drops anything else as it is typed
function onlyDigits(key: 'budgetFrom' | 'budgetTill', e: Event) {
    const target = e.target as HTMLInputElement;
    const digits = target.value.replace(/\D/g, '');
    if (digits !== target.value) target.value = digits;
    filters[key] = digits;
}

// New filters always start from the first page
function applyFilters() {
    if (currentPage.value !== 1) {
        notifyNext = true;
        currentPage.value = 1; // the watcher below fetches
    } else fetchDeals({ notify: true });
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

// The list is paged by the page size; the kanban asks GET /deals/board column by column.
const kanban = computed(() => route.query.view === 'kanban');

// The next load was asked for by the user (a filter, a preset): if it fails, a toast says so
let notifyNext = false;

// `options` from a watcher are its values, so only `{ notify: true }` counts
async function fetchDeals(options?: unknown) {
    const notify = (options as { notify?: boolean } | undefined)?.notify === true || notifyNext;
    notifyNext = false;
    if (kanban.value) return fetchBoard({ notify });

    const query: Record<string, any> = {
        ...filterQuery(),
        limit: perPage.value,
        skip: (currentPage.value - 1) * perPage.value,
        sort: sortBy.value,
    };

    dealsError.value = null;
    await run(dealsService.find(query).exec());
    if (dealsError.value) {
        // the old rows stay; the banner above the list says they are old
        listError.value = String(dealsError.value?.message || 'ошибка запроса');
        if (notify) toast.show({message: 'Не удалось применить фильтр: ' + listError.value, timeout: 5000, type: 'error'});
    } else listError.value = '';
}

/**
 * The whole board. `keepPages`: a live reload keeps as many cards per column as are shown
 * (a change of the filters starts every column from its first page).
 */
async function fetchBoard({ notify = false, keepPages = false }: { notify?: boolean, keepPages?: boolean } = {}) {
    const query = filterQuery();
    const seq = ++boardSeq;
    runDealStats(dealsService.get('stats', query).exec());
    const shown = keepPages ? Math.max(0, ...Object.values(board.columns).map((column) => column.deals.length)) : 0;
    boardLoading.value = !board.loaded;
    const result = await promiseResult(dealsService.get<BoardResponse>('board', { ...query, per_stage: Math.min(200, Math.max(BOARD_PAGE, shown)) }).exec());
    if (seq !== boardSeq) return;
    boardLoading.value = false;
    if (!result.ok) {
        // the old cards stay; the banner above the board says they are old
        listError.value = String(result.error?.message || 'ошибка запроса');
        if (notify) toast.show({message: 'Не удалось применить фильтр: ' + listError.value, timeout: 5000, type: 'error'});
        return;
    }
    listError.value = '';
    applyBoard(result.value);
}

// «Показать ещё» of a column: the next cards older than the last one shown
async function loadMore(stage: Stage) {
    const column = columnOf(stage.id);
    if (column.loading) return;
    const last = column.deals[column.deals.length - 1];
    column.loading = true;
    const result = await promiseResult(dealsService.get<BoardResponse>('board', {
        ...filterQuery(),
        stages: [stage.id],
        per_stage: BOARD_PAGE,
        ...(last ? { before_id: last.id } : {}),
    }).exec());
    column.loading = false;
    if (!result.ok) return toast.show({message: 'Не удалось загрузить сделки: ' + result.error.message, timeout: 4000, type: 'error'});
    for (const deal of result.value.data) {
        if (deal.stage?.id === stage.id && !column.deals.some((item) => item.id === deal.id)) column.deals.push(deal);
    }
    const total = result.value.stages.find((item) => item.stage_id === stage.id);
    if (total) {
        column.count = total.count;
        column.budget = Number(total.budget) || 0;
    }
}

/**
 * A live update named the deals that changed: only they are read again (and the totals of the
 * columns); a change of unknown or many deals reloads the board.
 */
async function refreshBoard(scope: number[] | '*' | undefined) {
    if (!board.loaded || !Array.isArray(scope) || !scope.length || scope.length > 50) return fetchBoard({ keepPages: true });
    const ids: number[] = scope;
    const seq = boardSeq;
    const query = filterQuery();
    runDealStats(dealsService.get('stats', query).exec());
    const [totals, fresh] = await Promise.all([
        promiseResult(dealsService.get<BoardResponse>('board', { ...query, per_stage: 0 }).exec()),
        promiseResult(dealsService.get<BoardResponse>('board', { ...query, ids, per_stage: 200 }).exec()),
    ]);
    if (seq !== boardSeq) return;
    if (!totals.ok || !fresh.ok) return fetchBoard({ keepPages: true });
    const complete: Record<number, boolean> = {};
    for (const [id, column] of Object.entries(board.columns)) {
        complete[Number(id)] = column.deals.length >= column.count;
        column.deals = column.deals.filter((deal) => !ids.includes(deal.id));
    }
    applyTotals(totals.value.stages);
    for (const deal of fresh.value.data) insertCard(deal, complete[deal.stage?.id ?? -1] ?? true);
}

// The filters of the page as the API takes them (GET /deals, /deals/stats, /deals/board)
function filterQuery(): Record<string, any> {
    const query: Record<string, any> = {};

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

    // the search box: number, name, client (name, phone, e-mail), company
    if (label.value?.trim()) {
        query.q = label.value.trim();
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

    const budgetFrom = String(filters.budgetFrom ?? '').replace(/\D/g, '');
    const budgetTill = String(filters.budgetTill ?? '').replace(/\D/g, '');
    if (budgetFrom) {
        query.budget_from = budgetFrom;
    }

    if (budgetTill) {
        query.budget_till = budgetTill;
    }

    // The API filters by created_after / created_before (createdAt[lt|gt] was ignored)
    if (dateFilter.end && dateFilter.start && !query.created_after && !query.created_before) {
        query.created_after = dateFilter.start;
        query.created_before = dateFilter.end;
    }

    return query;
}

watch(kanban, fetchDeals);
// live: deals created, moved or deleted elsewhere (others, triggers, Telegram, the bot);
// not while a card is being dragged — then right after the drop. Tasks change only the
// statistics of the board, and which deals match the task filters.
let liveMissed = false;
useLive((changes) => {
    if (liveTouches(changes, 'stages')) fetchStages();
    const dealsChanged = liveTouches(changes, 'deals');
    const tasksChanged = liveTouches(changes, 'tasks');
    const membership = dealsChanged || (tasksChanged && filters.tasks.length > 0);
    if (!kanban.value) {
        if (membership) fetchDeals();
        return;
    }
    if (!membership) {
        // a task of a deal: the statistics above the board
        if (tasksChanged) runDealStats(dealsService.get('stats', filterQuery()).exec());
        return;
    }
    if (dragging.value) liveMissed = true;
    else if (dealsChanged && !(tasksChanged && filters.tasks.length)) refreshBoard(changes.deals);
    else fetchBoard({ keepPages: true });
}, 1000);
watch(dragging, (now) => {
    if (!now && liveMissed) {
        liveMissed = false;
        if (kanban.value) fetchBoard({ keepPages: true });
        else fetchDeals();
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