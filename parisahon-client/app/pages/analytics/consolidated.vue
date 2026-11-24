<script setup lang="ts">
import AddonApexcharts from '~/components/tairo/AddonApexcharts.vue';
import PeriodPicker from '~/components/analytics/PeriodPicker.vue';
import type { ConsolidatedStats } from '~/types/stats';
import moment from 'moment';
import { countOf, formatSum } from '~/utils/format';
import { plainSafe } from '~/utils/sanitize';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Сводный отчет'
});

useHead({
    title: 'Сводный отчет'
});

// all time unless chosen (here or in another report); the API needs both ends
const { period: reportPeriod, bounds } = useReportPeriod('all');
const consolidatedService = useService('/analytics/consolidated-report', {auth: true});
const {data: consolidated, isLoading: consolidatedLoading, run: runConsolidated} = useAsync<ConsolidatedStats>({
    graph: [],
    deals: {
        total_stats: {
            total_deal_budget: 0,
            total_deal_count: 0,
            won_deal_count: 0,
            won_deal_budget: 0,
            lost_deal_count: 0,
            lost_deal_budget: 0,
        },
        stage_stats: [],
        user_stats: []
    },
    contacts: {
        total_stats: {
            total_ctr_agent_count: 0,
            total_company_count: 0,
        },
        user_stats: [],
    },
    tasks: {
        total_stats: {
            count: 0
        },
        user_stats: [],
        type_stats: []
    }
});

enum Period {
    Weekly = 'weekly',
    Monthly = 'monthly',
    Yearly = 'yearly'
}

const route = useRoute();
const colorMode = useColorMode();
// the step of the graph (weeks, months, years): ?step= — ?period= is the report period (useReportPeriod: period=all)
const period = computed(() => Object.values(Period).includes(route.query.step as Period) ? route.query.step as Period : Period.Weekly);

watch(() => [period.value, reportPeriod.value], fetchConsolidatedStats);

function fetchConsolidatedStats() {
    runConsolidated(consolidatedService.find({
        period: period.value,
        ...bounds.value,
    }).exec());
}

const COLORS = ['#4f46e5', '#16a34a', '#f43f5e', '#fb923c', '#db2777', '#7c3aed'];

/** a share in whole percent of the list it is in (rounded, not cut: the shares add up to about 100) */
function share(part: number | string, whole: number) {
    const n = Number(part) || 0;
    return whole > 0 ? Math.round((n / whole) * 100) : 0;
}
const sum = (rows: any[], key: string) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);

const stageTotal = computed(() => sum(consolidated.value.deals.stage_stats, 'deal_count_in_stage'));
const managerDealTotal = computed(() => sum(consolidated.value.deals.user_stats, 'deal_count'));
const managerDeals = computed(() => consolidated.value.deals.user_stats.filter((u: any) => Number(u.deal_count) > 0));
const contactTotal = computed(() => sum(consolidated.value.contacts.user_stats, 'company_count') + sum(consolidated.value.contacts.user_stats, 'ctr_agent_count'));
const contactRows = computed(() => consolidated.value.contacts.user_stats.filter((m: any) => Number(m.company_count) + Number(m.ctr_agent_count) > 0));
const taskTotal = computed(() => Number(consolidated.value.tasks.total_stats.count) || 0);

function bucketLabel(start: string, end: string) {
    const from = moment(start);
    if (period.value === Period.Yearly) return from.format('YYYY');
    if (period.value === Period.Monthly) return from.locale('ru').format('MMM YYYY');
    return `${from.format('DD.MM')}–${moment(end).format('DD.MM')}`;
}

// new, won and lost per week / month / year: bars, every step of the period (the API fills the empty ones)
const consolidatedByPeriods = computed(() => {
    const series: {name: string, data: number[]}[] = [
        { name: 'Новые', data: [] },
        { name: 'Выигранные', data: [] },
        { name: 'Закрытые без успеха', data: [] },
    ];
    const categories: string[] = [];
    for (const item of consolidated.value.graph) {
        categories.push(bucketLabel(item.date_start, item.date_end));
        series[0].data.push(item.new_count);
        series[1].data.push(item.won_count);
        series[2].data.push(item.lost_count);
    }

    return {
        type: 'bar',
        height: 340,
        series,
        options: {
            chart: { zoom: { enabled: false }, toolbar: { show: false } },
            colors: COLORS,
            dataLabels: { enabled: false },
            plotOptions: { bar: { columnWidth: categories.length > 20 ? '80%' : '55%', borderRadius: 2 } },
            legend: { position: 'top', horizontalAlign: 'left' },
            xaxis: { categories, labels: { rotate: -45, hideOverlappingLabels: true } },
            yaxis: { labels: { formatter: (v: number) => String(Math.round(v)) } },
            grid: { borderColor: colorMode.value === 'dark' ? '#334155' : '#f1f1f1' },
        },
    };
});

function donut(labels: string[], series: number[], totalLabel: string, total: () => number | string) {
    return {
        type: 'donut',
        height: 300,
        series,
        options: {
            colors: COLORS,
            labels,
            dataLabels: { enabled: false },
            stroke: { width: 0 },
            legend: { show: false },
            plotOptions: {
                pie: {
                    donut: {
                        labels: {
                            show: true,
                            value: { fontSize: '36px', fontWeight: 400 },
                            name: { offsetY: 40, fontWeight: 400 },
                            total: {
                                label: totalLabel,
                                show: true,
                                fontWeight: 400,
                                color: colorMode.value === 'dark' ? '#94a3b8' : '#64748b',
                                formatter: total,
                            },
                        },
                    },
                },
            },
        },
    };
}

// one ring, by stage (the list by manager is next to it)
const consolidatedByStages = computed(() => {
    const labels: string[] = [];
    const series: number[] = [];
    for (const item of consolidated.value.deals.stage_stats) {
        // the charts render labels and tooltips as HTML
        labels.push(plainSafe(item.name));
        series.push(Number(item.deal_count_in_stage));
    }
    return donut(labels, series, 'Всего сделок', () => stageTotal.value);
});

const consolidatedByContacts = computed(() => {
    const companies = Number(consolidated.value.contacts.total_stats.total_company_count) || 0;
    const people = Number(consolidated.value.contacts.total_stats.total_ctr_agent_count) || 0;
    const chart = donut(['Компании', 'Контакты'], [companies, people], 'Всего', () => companies + people);
    return { ...chart, options: { ...chart.options, legend: { show: true, position: 'bottom' } } };
});

const consolidatedByTasks = computed(() => {
    const labels: string[] = [];
    const series: number[] = [];
    for (const item of consolidated.value.tasks.type_stats) {
        labels.push(item.id == null ? 'Без типа' : plainSafe(item.name));
        series.push(Number(item.task_count));
    }
    return donut(labels, series, 'Все задачи', () => taskTotal.value);
});

onMounted(fetchConsolidatedStats);

</script>
<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <h1 class="text-xl">Сводный отчет</h1>
            <PeriodPicker v-model="reportPeriod" />
        </div>

        <!-- the totals of the period -->
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4" :class="consolidatedLoading ? 'opacity-60' : ''">
            <BaseCard class="p-4">
                <p class="text-xs uppercase text-muted-400 font-semibold">Новые сделки</p>
                <p class="text-2xl text-muted-800 dark:text-white">{{ countOf(Number(consolidated.deals.total_stats.total_deal_count), 'сделка', 'сделки', 'сделок') }}</p>
                <p class="text-sm text-muted-500">{{ formatSum(consolidated.deals.total_stats.total_deal_budget) }}</p>
            </BaseCard>
            <BaseCard class="p-4">
                <p class="text-xs uppercase text-muted-400 font-semibold">Выиграно</p>
                <p class="text-2xl text-success-600">{{ countOf(Number(consolidated.deals.total_stats.won_deal_count), 'сделка', 'сделки', 'сделок') }}</p>
                <p class="text-sm text-muted-500">{{ formatSum(consolidated.deals.total_stats.won_deal_budget) }}</p>
            </BaseCard>
            <BaseCard class="p-4">
                <p class="text-xs uppercase text-muted-400 font-semibold">Закрыто без успеха</p>
                <p class="text-2xl text-rose-500">{{ countOf(Number(consolidated.deals.total_stats.lost_deal_count), 'сделка', 'сделки', 'сделок') }}</p>
                <p class="text-sm text-muted-500">{{ formatSum(consolidated.deals.total_stats.lost_deal_budget) }}</p>
            </BaseCard>
        </div>

        <BaseCard class="p-4 sm:p-6 flex flex-col gap-4 min-w-0">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">
                    Динамика сделок
                </BaseHeading>
                <div class="overflow-x-auto max-w-full">
                    <BaseButtonGroup class="whitespace-nowrap">
                        <BaseButton color="default" :to="{path: '/analytics/consolidated', query: {...route.query, step: Period.Weekly}}"
                            :class="period === Period.Weekly ? 'toggle-selected' : ''">
                            <span>По неделям</span>
                        </BaseButton>
                        <BaseButton color="default" :to="{path: '/analytics/consolidated', query: {...route.query, step: Period.Monthly}}"
                            :class="period === Period.Monthly ? 'toggle-selected' : ''">
                            <span>По месяцам</span>
                        </BaseButton>
                        <BaseButton color="default" :to="{path: '/analytics/consolidated', query: {...route.query, step: Period.Yearly}}"
                            :class="period === Period.Yearly ? 'toggle-selected' : ''">
                            <span>По годам</span>
                        </BaseButton>
                    </BaseButtonGroup>
                </div>
            </div>
            <div class="w-full min-w-0">
                <AddonApexcharts v-bind="consolidatedByPeriods" />
            </div>
        </BaseCard>

        <BaseCard class="p-4 sm:p-6 flex flex-col gap-4 min-w-0">
            <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">
                Сделки по этапам и менеджерам
            </BaseHeading>
            <p class="text-sm text-muted-500 -mt-2">Сделки активной воронки, созданные за период, — по этапу, на котором они сейчас.</p>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="min-w-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Этапы продаж</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="stage of consolidated.deals.stage_stats" :key="stage.id">
                            <NuxtLink :to="{name: 'deals', query: {stage_id: stage.id, stage_name: stage.name}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-14 shrink-0 text-right">{{ share(stage.deal_count_in_stage, stageTotal) }}%</div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200 min-w-0">
                                    <span class="break-words">{{ stage.name }}</span>
                                    <span>{{ countOf(Number(stage.deal_count_in_stage), 'сделка', 'сделки', 'сделок') }}, {{ formatSum(stage.total_budget_in_stage) }}</span>
                                </div>
                            </NuxtLink>
                        </li>
                    </ul>
                </div>
                <div class="min-w-0 w-full">
                    <AddonApexcharts v-bind="consolidatedByStages" />
                </div>
                <div class="min-w-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Сделки по менеджерам</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="user of managerDeals" :key="user.id">
                            <NuxtLink :to="{name: 'deals', query: {user_id: user.id, username: user.username}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-14 shrink-0 text-right">{{ share(user.deal_count, managerDealTotal) }}%</div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200 min-w-0">
                                    <span class="break-words">{{ user.username }}</span>
                                    <span>{{ countOf(Number(user.deal_count), 'сделка', 'сделки', 'сделок') }}, {{ formatSum(user.deal_budget) }}</span>
                                </div>
                            </NuxtLink>
                        </li>
                        <li v-if="!managerDeals.length" class="text-sm text-muted-400">Нет сделок за период</li>
                    </ul>
                </div>
            </div>
        </BaseCard>

        <BaseCard class="p-4 sm:p-6 flex flex-col gap-4 min-w-0">
            <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">
                Клиенты
            </BaseHeading>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div class="min-w-0 w-full">
                    <AddonApexcharts v-bind="consolidatedByContacts" />
                </div>
                <div class="min-w-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Клиенты в сделках менеджеров</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="manager of contactRows" :key="manager.id">
                            <NuxtLink :to="{name: 'lists-contacts', query: {user_id: manager.id, username: manager.username}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-14 shrink-0 text-right">
                                    {{ share(Number(manager.company_count) + Number(manager.ctr_agent_count), contactTotal) }}%
                                </div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200 min-w-0">
                                    <span class="break-words">{{ manager.username }}</span>
                                    <span>
                                        {{ countOf(Number(manager.company_count), 'компания', 'компании', 'компаний') }},
                                        {{ countOf(Number(manager.ctr_agent_count), 'контакт', 'контакта', 'контактов') }}
                                    </span>
                                </div>
                            </NuxtLink>
                        </li>
                        <li v-if="!contactRows.length" class="text-sm text-muted-400">Нет клиентов в сделках</li>
                    </ul>
                </div>
            </div>
        </BaseCard>

        <BaseCard class="p-4 sm:p-6 flex flex-col gap-4 min-w-0">
            <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">
                Задачи
            </BaseHeading>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="min-w-0 w-full">
                    <AddonApexcharts v-bind="consolidatedByTasks" />
                </div>
                <div class="min-w-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Задачи по типу</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="type of consolidated.tasks.type_stats" :key="type.id ?? 'none'">
                            <NuxtLink :to="type.id == null ? {name: 'tasks'} : {name: 'tasks', query: {type_id: type.id, type_name: type.name}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-14 shrink-0 text-right">{{ share(type.task_count, taskTotal) }}%</div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200 min-w-0">
                                    <span class="break-words">{{ type.id == null ? 'Без типа' : type.name }}</span>
                                    <span>{{ countOf(Number(type.task_count), 'задача', 'задачи', 'задач') }}</span>
                                </div>
                            </NuxtLink>
                        </li>
                    </ul>
                </div>
                <div class="min-w-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Задачи по менеджерам</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="manager of consolidated.tasks.user_stats" :key="manager.id ?? 'none'">
                            <NuxtLink :to="manager.id == null ? {name: 'tasks'} : {name: 'tasks', query: {user_id: manager.id, username: manager.username}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-14 shrink-0 text-right">{{ share(manager.task_count, taskTotal) }}%</div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200 min-w-0">
                                    <span class="break-words">{{ manager.id == null ? 'Без ответственного' : manager.username }}</span>
                                    <span>{{ countOf(Number(manager.task_count), 'задача', 'задачи', 'задач') }}</span>
                                </div>
                            </NuxtLink>
                        </li>
                    </ul>
                </div>
            </div>
        </BaseCard>
    </div>
</template>
