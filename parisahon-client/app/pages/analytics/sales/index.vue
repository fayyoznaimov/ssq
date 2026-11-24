<script lang="ts" setup>
import BaseButton from '~/components/base/BaseButton.vue';
import PeriodPicker from '~/components/analytics/PeriodPicker.vue';
import type { DealStats } from '~/types/stats';
import { countOf, formatSum } from '~/utils/format';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Анализ продаж'
});

useHead({
    title: 'Анализ продаж'
});

enum Status {
    All = 1,
    Active = 2,
    Closed = 3
}

enum By {
    Budget = 1,
    Count = 2,
}

const route = useRoute();
// all deals by default: the same numbers as «Сводный отчёт» for the same period
const status = computed(() => Number(route.query.status) || Status.All);
const by = computed(() => Number(route.query.by) || By.Budget);
const analyticsService = useService('analytics/deals', {auth: true});
const { period, params: periodParams } = useReportPeriod('all');

const {data: deals, run: runDeals, isLoading} = useAsync<DealStats>({
    stages: [],
    average_deal_duration_in_minutes: null,
    total_deal_count: 0,
    total_deal_budget: 0,
    closed_deal_count: 0,
});

function fetchStats() {
    const query: Record<string, any> = { ...periodParams.value };
    if (status.value === Status.Active) query.is_active = true;
    if (status.value === Status.Closed) query.is_active = false;
    runDeals(analyticsService.find(query).exec());
}

const sortedStages = computed(() => [...deals.value.stages].sort((a, b) => a.order - b.order));

// the share of a stage in the deals shown (the stages add up to the whole: a deal is in one stage)
const totals = computed(() => {
    let budget = 0;
    let count = 0;
    for (const stage of sortedStages.value) {
        budget += Number(stage.total_deal_budget) || 0;
        count += Number(stage.deal_count) || 0;
    }
    return { budget, count };
});

function getPercent(stage: DealStats['stages'][0]) {
    const part = by.value === By.Budget ? Number(stage.total_deal_budget) : Number(stage.deal_count);
    const whole = by.value === By.Budget ? totals.value.budget : totals.value.count;
    if (!whole || !part) return 0;
    return Math.min(100, Math.round((part / whole) * 100));
}

/** Minutes as people say it: «45 мин», «5 ч», «2 д»; no data — a dash. */
function formatTime(minutes: number | string | null | undefined) {
    if (minutes === null || minutes === undefined || minutes === '') return '—';
    const n = Number(minutes);
    if (!Number.isFinite(n)) return '—';
    if (n < 60) return `${Math.max(1, Math.round(n))} мин`;
    if (n < 1440) return `${Math.round(n / 60)} ч`;
    return `${Math.round(n / 1440)} д`;
}

const statusLink = (value: Status) => ({ path: '/analytics/sales', query: { ...route.query, status: value } });
const byLink = (value: By) => ({ path: '/analytics/sales', query: { ...route.query, by: value } });

watch([status, period], fetchStats);
onMounted(fetchStats);
</script>
<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <h1 class="text-xl">Анализ продаж</h1>
            <PeriodPicker v-model="period" />
        </div>
        <div class="flex flex-wrap justify-between gap-3">
            <div class="overflow-x-auto max-w-full">
                <BaseButtonGroup class="whitespace-nowrap">
                    <BaseButton color="default" :to="statusLink(Status.All)" :class="status === Status.All ? 'toggle-selected' : ''">
                        <span>Все</span>
                    </BaseButton>
                    <BaseButton color="default" :to="statusLink(Status.Active)" :class="status === Status.Active ? 'toggle-selected' : ''">
                        <span>Открытые</span>
                    </BaseButton>
                    <BaseButton color="default" :to="statusLink(Status.Closed)" :class="status === Status.Closed ? 'toggle-selected' : ''">
                        <span>Закрытые</span>
                    </BaseButton>
                </BaseButtonGroup>
            </div>
            <div class="overflow-x-auto max-w-full">
                <BaseButtonGroup class="whitespace-nowrap">
                    <BaseButton color="default" :to="byLink(By.Budget)" :class="by === By.Budget ? 'toggle-selected' : ''">
                        <span>По бюджету</span>
                    </BaseButton>
                    <BaseButton color="default" :to="byLink(By.Count)" :class="by === By.Count ? 'toggle-selected' : ''">
                        <span>По количеству</span>
                    </BaseButton>
                </BaseButtonGroup>
            </div>
        </div>
        <p class="text-sm text-muted-500 -mt-2">
            Сделки активной воронки, созданные за период, — по этапу, на котором они сейчас (как в «Сводном отчёте»).
            Всего: {{ countOf(totals.count, 'сделка', 'сделки', 'сделок') }}, {{ formatSum(totals.budget) }}.
        </p>

        <div class="hidden lg:flex items-center gap-4 px-4 text-xs uppercase text-muted-400 font-semibold">
            <span class="w-64 shrink-0">Этап</span>
            <span class="w-28 shrink-0 text-right" title="Сколько в среднем сделка была на этапе, прежде чем перейти дальше">Ср. время в этапе</span>
            <span class="flex-1">Доля {{ by === By.Budget ? 'бюджета' : 'сделок' }}</span>
        </div>
        <ul class="flex flex-col gap-4 lg:px-4" :class="isLoading ? 'opacity-60' : ''">
            <li v-for="stage of sortedStages" :key="stage.id" class="flex flex-col gap-2 border-b pb-3 dark:border-muted-700 lg:flex-row lg:items-center lg:gap-4">
                <div class="flex flex-col gap-0.5 text-sm text-muted-900 lg:w-64 lg:shrink-0 dark:text-white min-w-0">
                    <span class="break-words">{{ stage.name }}</span>
                    <p class="text-xs text-muted-600 dark:text-muted-200">
                        <NuxtLink :to="{name: 'deals', query: {stage_id: stage.id, stage_name: stage.name}}" class="underline">{{ countOf(Number(stage.deal_count), 'сделка', 'сделки', 'сделок') }}</NuxtLink>
                        · {{ formatSum(stage.total_deal_budget) }}
                    </p>
                </div>
                <div class="text-sm text-muted-600 dark:text-muted-300 lg:w-28 lg:shrink-0 lg:text-right" :title="stage.stage_time_count ? `по ${stage.stage_time_count} переходам` : 'ни одна сделка ещё не ушла с этапа'">
                    <span class="lg:hidden text-muted-400">Ср. время в этапе: </span>{{ formatTime(stage.average_time_in_stage) }}
                </div>
                <div class="flex items-center gap-3 flex-1 min-w-0">
                    <div class="h-6 flex-1 rounded-sm bg-muted-100 dark:bg-muted-800 overflow-hidden">
                        <div class="h-full transition-[width] duration-500" :style="{ width: getPercent(stage) + '%', 'background-color': stage.color || '#04574d' }"></div>
                    </div>
                    <span class="w-12 shrink-0 text-right text-lg font-light">{{ getPercent(stage) }}%</span>
                </div>
            </li>
        </ul>
        <p class="text-sm text-muted-700 dark:text-muted-200">
            <template v-if="deals.closed_deal_count && deals.average_deal_duration_in_minutes !== null">
                Средний цикл закрытой сделки: <b>{{ formatTime(deals.average_deal_duration_in_minutes) }}</b>
                (по {{ countOf(deals.closed_deal_count, 'сделке', 'сделкам', 'сделкам') }})
            </template>
            <template v-else>Средний цикл сделки: нет закрытых сделок за этот период</template>
        </p>
    </div>
</template>
