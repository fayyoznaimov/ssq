<script lang="ts" setup>
import DatePicker from '@vuepic/vue-datepicker';
import moment from 'moment';
import Money from '~/components/common/Money.vue';
import { countOf } from '~/utils/format';
import FileIcon from '~/components/common/FileIcon.vue';
import BaseButtonGroup from '~/components/base/BaseButtonGroup.vue';
import type BaseAutocomplete from '~/components/form/BaseAutocomplete.vue';
import TairoPopover from '~/components/tairo/TairoPopover.vue';
import type { PaginatedResponse } from '~/types/generics';
import type {DesktopStats, FileStat, ObjectiveResultStat, UserStat} from '~/types/stats';
import { type User, UserRole } from '~/types/user';
import AddonApexcharts from '~/components/tairo/AddonApexcharts.vue';
import { NuxtLink } from '#components';
import type { RouteLocationRaw } from 'vue-router';
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

/**
 * First and last day of a period, both included (the API counts the last day in full): "Сегодня" is
 * today only (it was yesterday and today), "Неделя" the last 7 days with today (today was left out).
 * Computed at each load, so a page left open overnight moves on to the new day.
 */
function periodDates(p: Period): [string, string] {
    const day = (shift: number) => moment().subtract(shift, 'day').format('YYYY-MM-DD');
    switch (p) {
        case Period.Yesterday: return [day(1), day(1)];
        case Period.Week: return [day(6), day(0)];
        case Period.Month: return [day(29), day(0)];
        default: return [day(0), day(0)];
    }
}

const fileService = useService('files', {auth: true});
const userService = useService('users', {auth: true});
const staffService = useService('users/staff', {auth: true});
const userAnalyticsService = useService('analytics/users', {auth: true});
const desktopServie = useService('desktop', {auth: true});
const objectiveResultService = useService('analytics/objectives/results');

/** GET /desktop: the task counters, the comments of the period and the "won" stage the card links to. */
type Stats = DesktopStats & {
    task_stats: DesktopStats['task_stats'] & {comments?: string};
    won_stage?: {id: number, name: string} | null;
};

const { data: stats, run: runStats, isLoading: statsLoading } = useAsync<Stats>({
    task_stats: {
        tasks_overdue: '0',
        tasks_closed: '0',
        active_tasks: '0',
        deals_without_tasks: '0',
        incoming_calls: '0',
        outgoing_calls: '0',
        succesfull_deals: '0',
        comments: '0',
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

// the people picked in "Мои ▾": their numbers (the API filters by user_ids)
const picked = computed(() => !ownOnly.value && sel.value === Selector.Custom && selectedUsers.value.length > 0);

/** The first and the last day of the chosen period (both included). */
function currentRange(): [string, string] {
    if (period.value === Period.Custom && date.value?.length === 2) return [date.value[0], date.value[1]];
    return periodDates(period.value);
}

// the first load shows placeholders, a reload keeps the numbers in place
const statsLoaded = ref(false);

function fetchStats() {
    const [fromDate, tillDate] = currentRange();

    runStats(desktopServie.find({
        from_date: fromDate,
        till_date: tillDate,
        my_stats: ownOnly.value || sel.value === Selector.Mine,
        ...(picked.value ? {user_ids: selectedUsers.value.map((u) => u.id)} : {}),
    }).exec()).then(() => { statsLoaded.value = true; });
    // the newest files of the period (an agent: own ones, like the numbers); the list
    // of files is behind the "files" switch of the staff card (403 otherwise);
    // the files list takes the end exclusive: the day after the last one
    if (ability.can('read', 'File')) {
        runFiles(fileService.find({
            created_at_from: fromDate,
            created_at_till: moment(tillDate).add(1, 'day').format('YYYY-MM-DD'),
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

/** The staff accounts for "Мои ▾" (GET /users/staff, no page limit); an older API: users minus the contacts. */
async function staffUsers(): Promise<PaginatedResponse<User>> {
    try {
        return await staffService.find<PaginatedResponse<User>>().exec();
    } catch (e) {
        return await userService.find<PaginatedResponse<User>>({limit: 1000}).exec();
    }
}

const employees = computed(() => {
    return users.value.data.filter((u) => u.role !== UserRole.CtrAgent);
});

// "Сделки по менеджерам": the people of the numbers above (me for "Мои", the picked ones)
const shownUserStats = computed(() => {
    if (sel.value === Selector.Mine) return userStats.value.filter((u) => u.id === currentUser.value?.id);
    if (picked.value) return userStats.value.filter((u) => selectedUsers.value.some((s) => s.id === u.id));
    return userStats.value;
});

// the caption of a period: «за сегодня», «за 7 дней», «за 01.11–05.11»
const periodCaption = computed(() => {
    switch (period.value) {
        case Period.Today: return 'за сегодня';
        case Period.Yesterday: return 'за вчера';
        case Period.Week: return 'за 7 дней';
        case Period.Month: return 'за 30 дней';
        default: {
            const [from, till] = currentRange();
            return `за ${moment(from).format('DD.MM')}–${moment(till).format('DD.MM')}`;
        }
    }
});

const mineSelected = computed(() => ownOnly.value || sel.value === Selector.Mine);

/**
 * A counter opens the task list with the same tasks (the API counts them by the same rules):
 * mine (me or my group), the picked people's or everybody's; overdue — all of them now; upcoming —
 * open, not overdue, the span touching the period; closed — done in the period.
 */
function tasksLink(status: 'overdue' | 'upcoming' | 'closed'): RouteLocationRaw {
    const [from, till] = currentRange();
    const who = picked.value
        ? {user_id: selectedUsers.value.map((u) => String(u.id))}
        : {scope: mineSelected.value ? 'mine' : 'all'};
    const dates = status === 'upcoming' ? {from, till} : status === 'closed' ? {closed_from: from, closed_till: till} : {};
    return {path: '/tasks', query: {status, ...who, ...dates}};
}

/** The deals list for the same people: mine — my deals (responsible), one picked person — theirs. */
function dealsLink(extra: Record<string, string>): RouteLocationRaw {
    const query: Record<string, string> = {...extra};
    const person = mineSelected.value ? currentUser.value : picked.value && selectedUsers.value.length === 1 ? selectedUsers.value[0] : null;
    if (person) {
        query.user_id = String(person.id);
        query.username = person.username;
    }
    return {path: '/deals', query};
}

type StatCard = {key: string, title: string, value: string | number, caption: string, color: string, to?: RouteLocationRaw, hint?: string};

const statCards = computed<StatCard[]>(() => {
    const t = stats.value.task_stats ?? ({} as Stats['task_stats']);
    const [from, till] = currentRange();
    const won = stats.value.won_stage;
    const n = (v?: string | number | null) => Number(v ?? 0) || 0;
    return [
        {key: 'overdue', title: 'Просроченные задачи', value: n(t.tasks_overdue), caption: 'на сейчас',
            color: n(t.tasks_overdue) ? 'text-red-500' : 'text-muted-400', to: tasksLink('overdue'), hint: 'Открыть просроченные задачи'},
        {key: 'upcoming', title: 'Задачи к выполнению', value: n(t.active_tasks), caption: periodCaption.value,
            color: 'text-purple-600 dark:text-purple-400', to: tasksLink('upcoming'), hint: 'Открыть задачи периода'},
        {key: 'closed', title: 'Выполненные задачи', value: n(t.tasks_closed), caption: periodCaption.value,
            color: 'text-green-500', to: tasksLink('closed'), hint: 'Открыть выполненные задачи'},
        {key: 'no-task', title: 'Сделки без задач', value: n(t.deals_without_tasks), caption: 'на сейчас',
            color: n(t.deals_without_tasks) ? 'text-amber-500' : 'text-muted-400', to: dealsLink({preset: 'no-task'}), hint: 'Открыть сделки без задач'},
        {key: 'won', title: 'Успешные сделки', value: n(t.succesfull_deals), caption: periodCaption.value,
            color: 'text-green-500',
            to: won ? dealsLink({stage_id: String(won.id), stage_name: won.name, closed_from: from, closed_till: till}) : undefined,
            hint: 'Открыть сделки, закрытые успешно за период'},
        {key: 'comments', title: 'Примечания', value: n(t.comments), caption: periodCaption.value, color: 'text-primary-600 dark:text-primary-200'},
        {key: 'incoming', title: 'Входящие звонки', value: n(t.incoming_calls), caption: periodCaption.value, color: 'text-primary-600 dark:text-primary-200'},
        {key: 'outgoing', title: 'Исходящие звонки', value: n(t.outgoing_calls), caption: periodCaption.value, color: 'text-primary-600 dark:text-primary-200'},
    ];
});

// the total of «Сделки по менеджерам» is the sum of its list (the API total is used until the list is there)
const managerTotal = computed(() => {
    if (shownUserStats.value.length) {
        return {
            count: shownUserStats.value.reduce((sum, u) => sum + Number(u.deal_count || 0), 0),
            budget: shownUserStats.value.reduce((sum, u) => sum + Number(u.deal_budget || 0), 0),
        };
    }
    return {
        count: Number(stats.value.total_manager_stats?.deal_count || 0),
        budget: Number(stats.value.total_manager_stats?.total_budget || 0),
    };
});


const objectiveResult = computed(() => {
    let goalTotal = 0;
    let budgetTotal = 0;
    for (const group of results.value.groups) {
        if (group.objetives == null) continue;
        goalTotal += group.objetives.monthly;
        budgetTotal += group.total_budget;
    }

    // a share of the plan in per cent (it was floor(budget / goal) * 100: 0 % until the plan was met, then 100 %)
    const progress = goalTotal > 0 ? Math.round(budgetTotal / goalTotal * 100) : 0;
    return {
        progress: Number.isFinite(progress) ? progress : 0,
        budgetTotal,
        goalTotal
    }
});

const COLORS = ['#22c55e'];
const objectives = computed(() => {
    const height = 320;
    const type = 'radialBar';

    // the arc stops at 100 %, the label tells the real share (120 % of the plan)
    const real = objectiveResult.value.progress;
    const series = [Math.min(real, 100)];
    const options = {
        labels: ['План'],
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
                        fontSize: '16px',
                        formatter: () => `${real} %`,
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
// a new choice of people in "Мои ▾" (the route keeps sel=custom)
watch(selectedUsers, () => { if (sel.value === Selector.Custom) fetchStats(); });
// live: the numbers follow new deals, tasks, files and calls (at most every 2 s)
useLive((changes) => {
    if (["deals", "tasks", "events", "files", "calls"].some((t) => liveTouches(changes, t))) fetchStats();
}, 2000);

onMounted(() => {
    fetchStats();
    if (!ownOnly.value) run(staffUsers());
});

</script>
<template>
    <div>
        <!-- on a phone the period buttons are narrower and both groups may wrap instead of being cut off -->
        <div class="flex flex-wrap gap-3 justify-center">
            <BaseButtonGroup class="flex-wrap justify-center xs:[&_.nui-button]:!px-3">
                <BaseButton color="default" :to="{path: '/', query: {...route.query, period: Period.Today}}" :class="period === Period.Today ? 'toggle-selected' : ''">
                    <span>Сегодня</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/', query: {...route.query, period: Period.Yesterday}}" :class="period === Period.Yesterday ? 'toggle-selected' : ''">
                    <span>Вчера</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/', query: {...route.query, period: Period.Week}}"  :class="period === Period.Week ? 'toggle-selected' : ''">
                    <span>Неделя</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/', query: {...route.query, period: Period.Month}}" :class="period === Period.Month ? 'toggle-selected' : ''">
                    <span>Месяц</span>
                </BaseButton>
                <BaseButton color="default" :class="period === Period.Custom ? 'toggle-selected' : ''">
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
                <BaseButton color="default" :to="{path: '/', query: {...route.query, sel: Selector.All}}" :class="sel === Selector.All ? 'toggle-selected' : ''">Все</BaseButton>
                <div class="flex border dark:border-muted-600 text-sm items-center rounded-r-md" :class="sel === Selector.Mine || sel === Selector.Custom ? 'bg-primary-500/15 !border-primary-500 dark:bg-primary-500/25 font-semibold' : 'bg-white dark:bg-muted-700'">
                    <span v-if="sel === Selector.Custom" class="px-2.5">
                        <Icon v-if="usersLoading" name="lucide:loader-circle" class="animate-spin size-4" />
                        <template v-if="selectedUsers.length === 1">{{ selectedUsers[0].username }}</template>
                        <template v-if="selectedUsers.length > 1">{{ countOf(selectedUsers.length, 'менеджер', 'менеджера', 'менеджеров') }}</template>
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
        <!-- one number per card; a card that has a list behind it opens that list with the same filter -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mt-6 sm:mt-8">
            <component
                :is="card.to ? NuxtLink : 'div'"
                v-for="card in statCards"
                :key="card.key"
                v-bind="card.to ? {to: card.to} : {}"
                :title="card.to ? card.hint : undefined"
                class="block rounded-md border border-muted-200 bg-white p-3 sm:p-4 dark:border-muted-700 dark:bg-muted-800"
                :class="card.to ? 'transition-colors hover:border-primary-500 dark:hover:border-primary-400' : ''"
            >
                <p class="text-[11px] sm:text-xs font-medium uppercase leading-tight text-muted-500 dark:text-muted-300">{{ card.title }}</p>
                <p class="mt-2 text-3xl sm:text-4xl font-semibold leading-none" :class="card.color">
                    <BasePlaceload v-if="statsLoading && !statsLoaded" class="h-8 w-12 rounded" />
                    <template v-else>{{ card.value }}</template>
                </p>
                <p class="mt-2 flex items-center gap-1 text-xs text-muted-400">
                    <span>{{ card.caption }}</span>
                    <Icon v-if="card.to" name="ph:arrow-right" class="size-3" />
                </p>
            </component>
        </div>
        <div class="grid grid-cols-12 gap-4 mt-4">
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
                    <span class="text-xs text-muted-400">{{ periodCaption }}</span>
                </div>
                <!-- the total is the sum of the list below (the same deals: created in the period, by the responsible) -->
                <div class="mb-2 flex items-end justify-between gap-2">
                    <NuxtLink :to="dealsLink({})" class="text-4xl font-semibold text-purple-600 dark:text-purple-400 hover:underline">
                        {{ managerTotal.count }}
                    </NuxtLink>
                    <Money class="text-green-500 text-lg" :value="managerTotal.budget" />
                </div>
                <hr class="border border-muted-200 dark:border-muted-600" />
                <ul class="flex flex-col mt-2">
                    <li v-for="user in shownUserStats" :key="user.id" class="text-[15px] text-muted-700 dark:text-white flex items-center justify-between gap-2 border-t border-muted-200 dark:border-muted-700 first:border-t-0 py-1.5">
                        <NuxtLink :to="{path: '/deals', query: {user_id: String(user.id), username: user.username}}" class="hover:underline min-w-0 truncate">
                            {{ user.username }} <span class="font-medium">{{ countOf(Number(user.deal_count), 'сделка', 'сделки', 'сделок') }}</span>
                        </NuxtLink>
                        <Money class="text-green-500 shrink-0" :value="Number(user.deal_budget)" />
                    </li>
                    <li v-if="!shownUserStats.length && !userStatsLoading" class="text-sm text-muted-400 py-1.5">Нет сделок за период</li>
                </ul>
            </BaseCard>
            <BaseCard v-if="!ownOnly && objectiveResult.goalTotal > 0" class="col-span-12 md:col-span-6 xl:col-span-4 p-4 h-full">
                <div class="mb-1 flex items-center justify-between">
                    <BaseHeading
                        as="h5"
                        size="xs"
                        weight="medium"
                        lead="tight"
                        class="text-muted-500 dark:text-white uppercase"
                    >
                        <span>Цели на месяц</span>
                    </BaseHeading>
                    <span class="text-xs text-muted-400">{{ objectiveResult.progress }} %</span>
                </div>
                <AddonApexcharts v-bind="objectives" />
                <p class="text-center text-sm mt-4 text-muted-500 dark:text-white">
                    <Money class="text-purple-600 dark:text-purple-500" :value="objectiveResult.budgetTotal" /><br>
                    из <Money :value="objectiveResult.goalTotal" />
                </p>
            </BaseCard>
            <BaseCard v-if="ability.can('read', 'File')" class="col-span-12 md:col-span-6 xl:col-span-4 p-4 h-full">
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
                    <span class="text-xs text-muted-400">{{ periodCaption }}</span>
                </div>
                <ul v-if="files.data.length" class="max-h-80 flex flex-col gap-2 overflow-y-auto -mx-4 px-4">
                    <li v-for="file of files.data" :key="file.id" class="flex justify-between items-start gap-2">
                        <div class="flex items-center gap-2 min-w-0">
                            <FileIcon :file-name="file.name" />
                            <div class="text-sm text-muted-500 min-w-0">
                                <span class="break-all">{{ file.name }} ({{ formatBytes(Number(file.size)) }})</span>
                                <div class="flex flex-wrap gap-1">
                                    <NuxtLink v-for="deal in file.deals" :key="deal.id" :href="'/deals/' + deal.id">в <span class="underline">сделке {{ deal.label }}</span></NuxtLink>
                                </div>
                            </div>
                        </div>
                        <BaseButtonIcon size="sm" @click="download(file)" :disabled="isLoadingMap[file.id]">
                            <Icon v-if="isLoadingMap[file.id]" name="lucide:loader-circle" class="animate-spin"/>
                            <Icon v-else name="ph:download-simple" />
                        </BaseButtonIcon>
                    </li>
                </ul>
                <!-- nothing to show is not a warning -->
                <p v-else class="text-muted-400 text-sm mt-2">Файлов за период нет</p>
            </BaseCard>
        </div>
    </div>
</template>
