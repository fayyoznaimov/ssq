<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <div>
                <h1 class="text-xl">Аналитика по менеджерам</h1>
                <h2 class="text-sm text-gray-500">Все сотрудники за период: сделки, выигранные, клиенты, звонки, ответы</h2>
            </div>
            <PeriodPicker v-model="period" />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="sorted"
                :loading="isLoading"
                class="flex-auto"
                id="manager-analytics"
            >
            </BaseTable>
        </div>
        <!-- the empty state under the table: inside it the text was centred across nine columns and cut off -->
        <div v-if="!isLoading && !sorted.length" class="rounded-md border border-dashed border-muted-300 dark:border-muted-700 p-4 text-sm text-muted-500">
            За этот период у сотрудников нет ни сделок, ни звонков, ни ответов клиентам. Выберите другой период.
        </div>
        <p class="text-sm text-muted-500 max-w-4xl">
            Новые сделки — созданные за период, где сотрудник ответственный; выиграно — закрытые за период на этапе успеха
            (как в сводном отчёте и целях); звонки — записи звонков за период (как в «Звонках» и «Контроле»); время ответа —
            медиана в рабочие часы{{ stats.norm?.work_hours ? ` (${stats.norm.work_hours})` : '' }}, «в норме» — доля ответов
            не дольше {{ stats.norm?.sla_minutes ?? 15 }} мин, как в «Контроле».
        </p>
    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import PeriodPicker from '~/components/analytics/PeriodPicker.vue';
import { spoken } from '~/utils/duration';
import {type Column} from '~/components/common/types';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'По менеджерам'
});

useHead({
    title: 'По менеджерам'
});

// one row of GET /analytics/managers (AnalyticsService.managerAnalytics)
type ManagerRow = {
    id: number;
    username: string;
    role: string;
    group_name: string | null;
    deleted: boolean;
    deal_count: number;
    deal_budget: number;
    average_budget: number;
    won_count: number;
    won_budget: number;
    new_client_count: number;
    call_count: number;
    outgoing_call_count: number;
    incoming_call_count: number;
    call_minutes: number;
    first_response_median_sec: number | null;
    response_median_sec: number | null;
    in_sla_share: number | null;
};

type ManagerStats = {
    data: ManagerRow[];
    norm?: { sla_minutes: number; work_hours: string; work_days: string };
};

const ROLES: Record<string, string> = { admin: 'администратор', manager: 'менеджер', agent: 'агент' };

const statsService = useService('analytics/managers', {auth: true});
const { data: stats, isLoading, run } = useAsync<ManagerStats>({ data: [] });
const sortBy = ref<Record<string, number>>({});
// the current month unless another report chose a period (the API's default is the current month too)
const { period, bounds } = useReportPeriod('month');

/** Seconds of working time as people say it: "40 с", "12 мин", "3 ч 05 мин"; no value — a dash. */
const duration = spoken;

const columns = ref<Column<ManagerRow>[]>([
    {
        label: 'Сотрудник',
        name: 'username',
        icon: 'ph:identification-card',
        resizable: true,
        sortable: true,
        field: (item) => item.deleted ? `${item.username} (удалён)` : item.username,
        subtitle: (item) => [ROLES[item.role] ?? item.role, item.group_name].filter(Boolean).join(' · '),
    },
    {
        label: 'Новых сделок',
        name: 'deal_count',
        icon: 'ph:handshake',
        resizable: true,
        sortable: true,
    },
    {
        label: 'Сумма новых',
        name: 'deal_budget',
        icon: 'ph:money',
        resizable: true,
        sortable: true,
        money: true,
    },
    {
        label: 'Средний бюджет',
        name: 'average_budget',
        resizable: true,
        sortable: true,
        money: true,
    },
    {
        label: 'Выиграно',
        name: 'won_count',
        icon: 'ph:trophy',
        resizable: true,
        sortable: true,
    },
    {
        label: 'Сумма выигранных',
        name: 'won_budget',
        resizable: true,
        sortable: true,
        money: true,
    },
    {
        label: 'Новых клиентов',
        name: 'new_client_count',
        icon: 'ph:user-plus',
        resizable: true,
        sortable: true,
    },
    {
        label: 'Звонков',
        name: 'call_count',
        icon: 'ph:phone',
        resizable: true,
        sortable: true,
        subtitle: (item) => `↗ ${item.outgoing_call_count} · ↙ ${item.incoming_call_count}`,
    },
    {
        label: 'Время разговоров',
        name: 'call_minutes',
        icon: 'ph:headset',
        resizable: true,
        sortable: true,
        field: (item) => (item.call_count ? spoken(Math.round(Number(item.call_minutes) * 60)) : '—'),
    },
    {
        label: 'Первый ответ (медиана)',
        name: 'first_response_median_sec',
        icon: 'ph:timer',
        resizable: true,
        sortable: true,
        field: (item) => duration(item.first_response_median_sec),
    },
    {
        label: 'Ответ клиенту (медиана)',
        name: 'response_median_sec',
        icon: 'ph:chat-circle-dots',
        resizable: true,
        sortable: true,
        field: (item) => duration(item.response_median_sec),
    },
    {
        label: 'В норме',
        name: 'in_sla_share',
        resizable: true,
        sortable: true,
        field: (item) => item.in_sla_share === null || item.in_sla_share === undefined ? '—' : `${item.in_sla_share} %`,
    },
]);

// the table sorts by the raw value of the column (seconds, sums), not by its text
const sorted = computed(() => {
    const rows = [...(stats.value.data ?? [])];
    const [key, order] = Object.entries(sortBy.value)[0] ?? [];
    if (!key) return rows;
    return rows.sort((a: any, b: any) => {
        const x = a[key];
        const y = b[key];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const less = typeof x === 'string' ? x.localeCompare(y, 'ru') < 0 : x < y;
        return (less ? -1 : 1) * (order === -1 ? -1 : 1);
    });
});

function fetchStats() {
    // «за всё время»: both far ends (without dates the API counts the current month)
    run(statsService.find(bounds.value).exec());
}

watch(period, fetchStats);
onMounted(fetchStats);
</script>

<style>
</style>
