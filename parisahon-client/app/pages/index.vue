<script lang="ts" setup>
import DatePicker from '@vuepic/vue-datepicker';
import moment from 'moment';
import Money from '~/components/common/Money.vue';
import FileIcon from '~/components/common/FileIcon.vue';
import BaseButtonGroup from '~/components/base/BaseButtonGroup.vue';
import type BaseAutocomplete from '~/components/form/BaseAutocomplete.vue';
import TairoPopover from '~/components/tairo/TairoPopover.vue';
import type { PaginatedResponse } from '~/types/generics';
import type {DesktopStats, FileStat, ObjectiveResultStat, UserStat} from '~/types/stats';
import { type User, UserRole } from '~/types/user';
import AddonApexcharts from '~/components/tairo/AddonApexcharts.vue';
import type { MyFile } from '~/types/file';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Панель управления',
});

useHead({
    title: 'Панель управления',
});

enum Period {
    Today = 'today',
    Yesterday = 'yesterday',
    Week = 'week',
    Month = 'month',
    Custom = 'custom'
}

enum Selector {
    All = 'all',
    Mine = 'mine',
    Custom = 'custom'
}

const periodTranslationMap: Record<Period, string> = {
    [Period.Today]: 'Сегодня',
    [Period.Yesterday]: 'Вчера',
    [Period.Week]: 'Неделя',
    [Period.Month]: 'Месяц',
    [Period.Custom]: 'Период'
};

const periodDatesMap: Record<Period, [string, string]> = {
    [Period.Today]: [moment().subtract(1, 'day').format('YYYY-MM-DD'), moment().add(1, 'day').format('YYYY-MM-DD')],
    [Period.Yesterday]: [moment().subtract(2, 'day').format('YYYY-MM-DD'), moment().format('YYYY-MM-DD')],
    [Period.Week]: [moment().subtract(1, 'week').format('YYYY-MM-DD'), moment().format('YYYY-MM-DD')],
    [Period.Month]: [moment().subtract(31, 'day').format('YYYY-MM-DD'), moment().add(1, 'day').format('YYYY-MM-DD')],
    [Period.Custom]: [moment().format('YYYY-MM-DD'), moment().format('YYYY-MM-DD')]
}; 

const fileService = useService('files', {auth: true});
const userService = useService('users', {auth: true});
const userAnalyticsService = useService('analytics/users', {auth: true});
const desktopServie = useService('desktop', {auth: true});
const objectiveResultService = useService('analytics/objectives/results');

const { data: stats, run: runStats, isLoading: statsLoading } = useAsync<DesktopStats>({
    task_stats: {
        tasks_overdue: '0',
        tasks_closed: '0',
        active_tasks: '0',
        deals_without_tasks: '0',
        incoming_calls: '0',
        outgoing_calls: '0',
        succesfull_deals: '',
    },
    total_manager_stats: {
        total_budget: '0',
        deal_count: '0',
    },
    file_stats: []
});

const { data: results, run: runResults } = useAsync<{groups: ObjectiveResultStat[]}>({groups: []});
const { run, data: users, isLoading: usersLoading } = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});
const { data: files, run: runFiles, isLoading: filesLoading } = useAsync<PaginatedResponse<MyFile>>({
    data: [],
});
const { data: userStats, isLoading: userStatsLoading, run: runUserStats } = useAsync<UserStat[]>([]);
const { runWithId, isLoadingMap } = useAsync();

const isDarkMode = useDarkMode();
const date = ref();
const toast = useToast('GlobalToast');
const route = useRoute();
const router = useRouter();
const currentUser = useState<User>('user');
// An agent (sales manager) sees only their own numbers: company-wide statistics,
// goals and "deals by manager" are for admin and manager (403 for an agent).
const ownOnly = computed(() => currentUser.value?.role === UserRole.Agent);
const ability = useAppAbility();
const period = ref(route.query.period as Period || Period.Today);
const sel = ref(ownOnly.value ? Selector.Mine : (route.query.sel as Selector || Selector.All));
const selectedUsers = ref<User[]>([]);

function fetchStats() {
    let [fromDate, tillDate] = periodDatesMap[period.value];
    if (period.value === Period.Custom) {
        [fromDate, tillDate] = date.value;
    }

    runStats(desktopServie.find({from_date: fromDate, till_date: tillDate, my_stats: ownOnly.value || sel.value === Selector.Mine}).exec());
    // the newest files of the period (an agent: own ones, like the numbers); the list
    // of files is behind the "files" switch of the staff card (403 otherwise)
    if (ability.can('read', 'File')) {
        runFiles(fileService.find({
            created_at_from: fromDate,
            created_at_till: tillDate,
            limit: 10,
            ...(ownOnly.value ? {uploaded_by: currentUser.value?.id} : {}),
        }).exec());
    }
    if (ownOnly.value) return;
    runResults(objectiveResultService.find({
        from_date: moment().set('year', 2020).startOf('year').format('YYYY-MM-DD'),
        till_date: moment().set('year', 2100).endOf('year').format('YYYY-MM-DD')
    }).exec());
    runUserStats(userAnalyticsService.find({from_date: fromDate, till_date: tillDate}).exec());
}

function periodDisplay(period: Period) {
    if (period === Period.Custom) return `${date.value[0]} - ${date.value[1]}`;
    return periodTranslationMap[period];
}

function onPopoverChange(open: boolean) {
    if (!open && selectedUsers.value.length > 0) {
        router.push({path: '/', query: {...route.query, sel: Selector.Custom, selectedUsers: selectedUsers.value.map((u) => u.id)}});
    } else if (!open && selectedUsers.value.length === 0) {
        router.push({path: '/', query: {...route.query, sel: Selector.All}});
    }
}

async function download(file: FileStat) {
    const result = await promiseResult(runWithId(downloadFile(uploadUrl(file.path), file.name), file.id));
    if (!result.ok) toast.show({message: result.error.message, type: 'error', timeout: 3000});
}

const employees = computed(() => {
    return users.value.data.filter((u) => u.role !== UserRole.CtrAgent);
});


const objectiveResult = computed(() => {
    let goalTotal = 0;
    let budgetTotal = 0;
    for (const group of results.value.groups) {
        if (group.objetives == null) continue;
        goalTotal += group.objetives.monthly;
        budgetTotal += group.total_budget;
    }

    const progress = Math.floor(budgetTotal / goalTotal);
    return {
        progress: !Number.isFinite(progress) ? 0 : progress * 100,
        budgetTotal,
        goalTotal
    }
});

const COLORS = ['#22c55e'];
const objectives = computed(() => {
    const height = 320;
    const type = 'radialBar';

    const series = [objectiveResult.value.progress];
    const options = {
        dataLabels: {
            style: {
                fontSize: '12px',
                weight: 500,
                colors: COLORS,
            },
            offsetY: -20,
            formatter: (value: number) => {
                return formatMoney(value, 0, {spaceBetweenAmountAndSymbol: ' ', symbolOnLeft: false});
            },
        },
        plotOptions: {
            radialBar: {
                startAngle: -90,
                endAngle: 90,
                track: {
                    background: 'red',
                    strokeWidth: '97%',
                    margin: 5,
                },
                dataLabels: {
                    name: {
                        show: false,
                    },
                    value: {
                        offsetY: -2,
                        fontSize: '16px'
                    }
                },
            }
        },
        fill: {
            type: 'solid',
            colors: COLORS,
        },
        grid: {
            padding: {
                top: -10
            }
        },
    };

    return {
        type,
        height,
        options,
        series
    };
});

watch(() => route.query, () => {
    period.value = route.query.period as Period || Period.Today;
    sel.value = ownOnly.value ? Selector.Mine : (route.query.sel as Selector || Selector.All);
    if (sel.value === Selector.All || sel.value === Selector.Mine) selectedUsers.value = [];
});

watch(date, (value) => {
    if (value) {
        period.value = Period.Custom;
    }
}); 
watch(employees, () => {
    if (!route.query.selectedUsers) return;
    const selected = [route.query.selectedUsers].flat();
    const users = employees.value.filter((e) => selected.some((s) => e.id === Number(s)));
    selectedUsers.value = users;
});

watch([period, sel], fetchStats);
// live: the numbers follow new deals, tasks, files and calls (at most every 2 s)
useLive((changes) => {
    if (["deals", "tasks", "events", "files", "calls"].some((t) => liveTouches(changes, t))) fetchStats();
}, 2000);

onMounted(() => {
    fetchStats();
    if (!ownOnly.value) run(userService.find({limit: 1000}).exec());
});

</script>
<template>
    <div>
        <!-- on a phone the period buttons are narrower and both groups may wrap instead of being cut off -->
        <div class="flex flex-wrap gap-3 justify-center">
            <BaseButtonGroup class="flex-wrap justify-center xs:[&_.nui-button]:!px-3">
                <BaseButton color="default" :to="{path: '/', query: {...route.query, period: Period.Today}}" :class="period === Period.Today ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <span>Сегодня</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/', query: {...route.query, period: Period.Yesterday}}" :class="period === Period.Yesterday ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <span>Вчера</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/', query: {...route.query, period: Period.Week}}"  :class="period === Period.Week ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <span>Неделя</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/', query: {...route.query, period: Period.Month}}" :class="period === Period.Month ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <span>Месяц</span>
                </BaseButton>
                <BaseButton color="default" :class="period === Period.Custom ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <DatePicker 
                        v-model="date"
                        format="dd-MM-yyyy" 
                        range 
                        :enable-time-picker="false"
                        model-type="yyyy-MM-dd"
                        :dark="isDarkMode"
                        :clearable="false"
                        :partial-range="false"
                    >
                        <template #dp-input="{ onInput, value, onBlur, onPaste }">
                            <div class="flex items-center justify-center">
                                <Icon name="ph:calendar" class="size-4 me-1" />
                                <span v-if="value">{{value}}</span>
                                <span v-else>Период</span>
                            </div>
                        </template>
                    </DatePicker>
                </BaseButton>
            </BaseButtonGroup>
            <BaseButtonGroup v-if="!ownOnly">
                <BaseButton color="default" :to="{path: '/', query: {...route.query, sel: Selector.All}}" :class="sel === Selector.All ? '!bg-muted-200 dark:!bg-muted-600' : ''">Все</BaseButton>
                <div class="flex border dark:border-muted-600 text-sm items-center rounded-r-md" :class="sel === Selector.Mine || sel === Selector.Custom ? 'bg-muted-200 dark:bg-muted-600' : 'bg-white dark:bg-muted-700'">
                    <span v-if="sel === Selector.Custom" class="px-2.5">
                        <Icon v-if="usersLoading" name="lucide:loader-circle" class="animate-spin size-4" />
                        <template v-if="selectedUsers.length === 1">{{ selectedUsers[0].username }}</template>
                        <template v-if="selectedUsers.length > 1">{{ selectedUsers.length }} менеджера</template>
                    </span>
                    <NuxtLink v-else class="h-full pl-2.5 flex items-center text-muted-700 dark:text-muted-200" :to="{path: '/', query: {...route.query, sel: Selector.Mine}}">Мои</NuxtLink>
                    <TairoPopover orientation="end" @change="onPopoverChange">
                        <button class="px-2.5 text-muted-700 dark:text-muted-200">
                            <Icon name="ph:caret-down" class="size-4"/>
                        </button>
                        <template #content>
                            <div class="p-2">
                                <BaseAutocomplete 
                                    v-model="selectedUsers"
                                    :items="employees" 
                                    :properties="{label: 'username', value: 'id', sublabel: (u: User)  => u.group?.name}" 
                                    :loading="usersLoading"
                                    :fixed="true" 
                                    dropdown
                                    multiple
                                />
                            </div>
                        </template>
                    </TairoPopover>
                </div>
            </BaseButtonGroup>
        </div>
        <div class="grid grid-cols-12 gap-4 mt-8">
            <div class="grid grid-cols-2 col-span-12 xl:col-span-4 gap-4">
                <BaseCard class="p-4 col-span-2 sm:col-span-1">
                    <div class="mb-1 flex items-center justify-between">
                        <BaseHeading
                            as="h5"
                            size="xs"
                            weight="medium"
                            lead="tight"
                            class="text-muted-500 dark:text-white uppercase"
                        >
                            <span>Просреченные задачи</span>
                        </BaseHeading>
                    </div>
                    <div class="mb-2">
                        <BaseHeading
                            as="h4"
                            size="5xl"
                            weight="semibold"
                            lead="tight"
                            class="text-purple-600"
                        >
                            <span>{{ stats.task_stats?.tasks_overdue }}</span>
                        </BaseHeading>
                    </div>
                    <hr class="border border-muted-200 dark:border-muted-600" />
                    <div class="text-green-500 flex flex-col font-sans text-2xl mt-2">
                        <span>{{ stats.task_stats?.tasks_overdue }}</span>
                        <span class="text-muted-400 text-xs"> за {{ periodDisplay(period) }}</span>
                    </div>
                </BaseCard>
                <BaseCard class="p-4 col-span-2 sm:col-span-1">
                    <div class="mb-1 flex items-center justify-between">
                        <BaseHeading
                            as="h5"
                            size="xs"
                            weight="medium"
                            lead="tight"
                            class="text-muted-500 dark:text-white uppercase"
                        >
                            <span>Выполненные задачи</span>
                        </BaseHeading>
                    </div>
                    <div class="mb-2">
                        <BaseHeading
                            as="h4"
                            size="5xl"
                            weight="semibold"
                            lead="tight"
                            class="text-green-500"
                        >
                            <span>{{ stats.task_stats?.tasks_closed }}</span>
                        </BaseHeading>
                        <span class="text-muted-400 text-xs mt-2"> за {{ periodDisplay(period) }}</span>
                    </div>
                </BaseCard>
                <BaseCard class="p-4 col-span-2 sm:col-span-1">
                    <div class="mb-1 flex items-center justify-between">
                        <BaseHeading
                            as="h5"
                            size="xs"
                            weight="medium"
                            lead="tight"
                            class="text-muted-500 dark:text-white uppercase"
                        >
                            <span>Задачи к выполнению</span>
                        </BaseHeading>
                    </div>
                    <div class="mb-2">
                        <BaseHeading
                            as="h4"
                            size="5xl"
                            weight="semibold"
                            lead="tight"
                            class="text-purple-600"
                        >
                            <span>{{ stats.task_stats?.active_tasks }}</span>
                        </BaseHeading>
                    </div>
                    <hr class="border border-muted-200 dark:border-muted-600" />
                    <div class="text-green-500 flex flex-col font-sans text-2xl mt-2">
                        <span>{{ stats.task_stats?.active_tasks }}</span>
                        <span class="text-muted-400 text-xs"> за {{ periodDisplay(period) }}</span>
                    </div>
                </BaseCard>
                <BaseCard class="p-4 col-span-2 sm:col-span-1">
                    <div class="mb-1 flex items-center justify-between">
                        <BaseHeading
                            as="h5"
                            size="xs"
                            weight="medium"
                            lead="tight"
                            class="text-muted-500 dark:text-white uppercase"
                        >
                            <span>Сделки без задач</span>
                        </BaseHeading>
                    </div>
                    <div class="mb-2">
                        <BaseHeading
                            as="h4"
                            size="5xl"
                            weight="semibold"
                            lead="tight"
                            class="text-purple-600"
                        >
                            <span>{{ stats.task_stats?.deals_without_tasks }}</span>
                        </BaseHeading>
                    </div>
                    <hr class="border border-muted-200 dark:border-muted-600" />
                    <div class="text-green-500 flex flex-col font-sans text-2xl mt-2">
                        <span>{{ stats.task_stats?.deals_without_tasks }}</span>
                        <span class="text-muted-400 text-xs"> за {{ periodDisplay(period) }}</span>
                    </div>
                </BaseCard>
            </div>
            <BaseCard class="col-span-12 md:col-span-6 xl:col-span-4 p-4 h-full">
                <div class="mb-1 flex items-center justify-between">
                    <BaseHeading
                        as="h5"
                        size="xs"
                        weight="medium"
                        lead="tight"
                        class="text-muted-500 dark:text-white uppercase"
                    >
                        <span>Источники сделок</span>
                    </BaseHeading>
                </div>
                <p class="text-amber-500 text-sm mt-2">
                    <Icon name="ph:warning" />
                    Недастаточно данных для отображения
                </p>
            </BaseCard>
            <BaseCard v-if="!ownOnly" class="col-span-12 md:col-span-6 xl:col-span-4 p-4 h-full">
                <div class="mb-1 flex items-center justify-between">
                    <BaseHeading
                        as="h5"
                        size="xs"
                        weight="medium"
                        lead="tight"
                        class="text-muted-500 dark:text-white uppercase"
                    >
                        <span>Сделки по менеджерам</span>
                    </BaseHeading>
                </div>
                <div class="mb-2 flex justify-between">
                    <BaseHeading
                        as="h4"
                        size="5xl"
                        weight="semibold"
                        lead="tight"
                        class="text-purple-600"
                    >
                        <span>{{ stats.total_manager_stats.deal_count }}</span>
                    </BaseHeading>
                    <div class="text-green-500 flex flex-col font-sans text-2xl mt-2 text-right">
                        <span>{{ stats.total_manager_stats.deal_count }}</span>
                        <span class="text-muted-400 text-xs"> за {{ periodDisplay(period) }}</span>
                    </div>
                </div>
                <hr class="border border-muted-200 dark:border-muted-600" />
                <ul class="flex flex-col mt-2">
                    <li v-for="user in userStats" class="text-[15px] text-muted-700 dark:text-white flex items-center justify-between border-t-2 border-t-amber-500 first:border-t-0 py-1.5">
                        <p>{{ user.username }} <span class="font-medium">{{ user.deal_count }} сделок</span></p>
                        <Money class="text-green-500" :value="Number(user.deal_budget)" />
                    </li>
                    <li v-if="!userStats.length && !userStatsLoading" class="text-sm text-muted-400 py-1.5">Нет сделок за период</li>
                </ul>
            </BaseCard>
            <BaseCard v-if="!ownOnly" class="col-span-12 md:col-span-6 xl:col-span-4 p-4 h-full">
                <div class="mb-1 flex items-center justify-between">
                    <BaseHeading
                        as="h5"
                        size="xs"
                        weight="medium"
                        lead="tight"
                        class="text-muted-500 dark:text-white uppercase"
                    >
                        <span>Цели</span>
                    </BaseHeading>
                </div>
                <AddonApexcharts v-bind="objectives" />
                <p class="text-center text-sm mt-4 text-muted-500 dark:text-white">
                    <Money class="text-purple-600 dark:text-purple-500" :value="objectiveResult.budgetTotal" /><br>
                    из <Money :value="objectiveResult.goalTotal" />
                </p>
            </BaseCard>
            <BaseCard class="col-span-12 md:col-span-6 xl:col-span-4 p-4 h-full">
                <div class="mb-1 flex items-center justify-between">
                    <BaseHeading
                        as="h5"
                        size="xs"
                        weight="medium"
                        lead="tight"
                        class="text-muted-500 dark:text-white uppercase"
                    >
                        <span>Последние файлы</span>
                    </BaseHeading>
                </div>
                <ul v-if="files.data.length" class="max-h-80 flex flex-col gap-2 overflow-y-auto -mx-4 px-4">
                    <li v-for="file of files.data" class="flex justify-between items-start">
                        <div class="flex items-center gap-2">
                            <FileIcon :file-name="file.name" />
                            <div class="text-sm text-muted-500">
                                <span>{{ file.name }} ({{ formatBytes(Number(file.size)) }})</span>
                                <div class="flex gap-1">
                                    <NuxtLink v-for="deal in file.deals" :href="'/deals/' + deal.id">в <span class="underline">Сделка {{ deal.label }}</span></NuxtLink>
                                </div>
                            </div>
                        </div>
                        <BaseButtonIcon size="sm" @click="download(file)" :disabled="isLoadingMap[file.id]">
                            <Icon v-if="isLoadingMap[file.id]" name="lucide:loader-circle" class="animate-spin"/>
                            <Icon v-else name="ph:download-simple" />
                        </BaseButtonIcon>
                    </li>
                </ul>
                <p v-else class="text-amber-500 text-sm mt-2">
                    <Icon name="ph:warning" />
                    Недастаточно данных для отображения
                </p>
            </BaseCard>
            <div class="grid grid-cols-2 col-span-12 xl:col-span-4 gap-4">
                <BaseCard class="p-4 col-span-2 sm:col-span-1">
                    <div class="mb-1 flex items-center justify-between">
                        <BaseHeading
                            as="h5"
                            size="xs"
                            weight="medium"
                            lead="tight"
                            class="text-muted-500 dark:text-white uppercase"
                        >
                            <span>Входящие звонки</span>
                        </BaseHeading>
                    </div>
                    <div class="mb-2">
                        <BaseHeading
                            as="h4"
                            size="5xl"
                            weight="semibold"
                            lead="tight"
                            class="text-green-500"
                        >
                            <span>{{ stats.task_stats?.incoming_calls }}</span>
                        </BaseHeading>
                        <span class="text-muted-400 text-xs mt-2"> за {{ periodDisplay(period) }}</span>
                    </div>
                </BaseCard>
                <BaseCard class="p-4 col-span-2 sm:col-span-1">
                    <div class="mb-1 flex items-center justify-between">
                        <BaseHeading
                            as="h5"
                            size="xs"
                            weight="medium"
                            lead="tight"
                            class="text-muted-500 dark:text-white uppercase"
                        >
                            <span>Исходящие звонки</span>
                        </BaseHeading>
                    </div>
                    <div class="mb-2">
                        <BaseHeading
                            as="h4"
                            size="5xl"
                            weight="semibold"
                            lead="tight"
                            class="text-green-500"
                        >
                            <span>{{ stats.task_stats?.outgoing_calls }}</span>
                        </BaseHeading>
                        <span class="text-muted-400 text-xs mt-2"> за {{ periodDisplay(period) }}</span>
                    </div>
                </BaseCard>
                <BaseCard class="p-4 col-span-2 sm:col-span-1">
                    <div class="mb-1 flex items-center justify-between">
                        <BaseHeading
                            as="h5"
                            size="xs"
                            weight="medium"
                            lead="tight"
                            class="text-muted-500 dark:text-white uppercase"
                        >
                            <span>Примечаний</span>
                        </BaseHeading>
                    </div>
                    <div class="mb-2">
                        <BaseHeading
                            as="h4"
                            size="5xl"
                            weight="semibold"
                            lead="tight"
                            class="text-green-500"
                        >
                            <span>0</span>
                        </BaseHeading>
                        <span class="text-muted-400 text-xs mt-2"> за {{ periodDisplay(period) }}</span>
                    </div>
                </BaseCard>
                <BaseCard class="p-4 col-span-2 sm:col-span-1">
                    <div class="mb-1 flex items-center justify-between">
                        <BaseHeading
                            as="h5"
                            size="xs"
                            weight="medium"
                            lead="tight"
                            class="text-muted-500 dark:text-white uppercase"
                        >
                            <span>Успешные сделки</span>
                        </BaseHeading>
                    </div>
                    <div class="mb-2">
                        <BaseHeading
                            as="h4"
                            size="5xl"
                            weight="semibold"
                            lead="tight"
                            class="text-purple-600"
                        >
                            <span>{{ stats.task_stats?.succesfull_deals }}</span>
                        </BaseHeading>
                    </div>
                    <hr class="border border-muted-200 dark:border-muted-600" />
                    <div class="text-green-500 flex flex-col font-sans text-2xl mt-2">
                        <span>{{ stats.task_stats?.succesfull_deals }}</span>
                        <span class="text-muted-400 text-xs"> за {{ periodDisplay(period) }}</span>
                    </div>
                </BaseCard>
            </div>
        </div>
    </div>
</template>

