<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-wrap items-center gap-4">
            <div>
                <h1 class="text-xl">Аналитика по менеджерам</h1>
                <h2 class="text-sm text-gray-500">Все сотрудники за период: сделки, выигранные, клиенты, звонки, ответы</h2>
            </div>
            <div class="max-w-xs w-full shrink-0">
                <DatePicker
                    v-model="dateRange"
                    :format="format"
                    range
                    text-input
                    vertical
                    :preset-dates="presetDates"
                    auto-apply
                    :enable-time-picker="false"
                    model-type="yyyy-MM-dd"
                    :teleport="true"
                    :dark="colorMode.value === 'dark'"
                >
                    <template #dp-input="{ onInput, value, onBlur, onPaste }">
                        <BaseInput :value="value" @input="onInput" @blur="onBlur" @paste="onPaste" placeholder="Период" />
                    </template>
                </DatePicker>
            </div>
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
        <p class="text-sm text-muted-500 max-w-4xl">
            Новые сделки — созданные за период, где сотрудник ответственный; выиграно — закрытые за период на этапе успеха
            (как в сводном отчёте и целях); звонки — записи звонков за период (как в «Звонках» и «Контроле»); время ответа —
            медиана в рабочие часы{{ stats.norm?.work_hours ? ` (${stats.norm.work_hours})` : '' }}, «в норме» — доля ответов
            не дольше {{ stats.norm?.sla_minutes ?? 15 }} мин, как в «Контроле».
        </p>
    </div>
</template>

<script lang="ts" setup>
import moment from 'moment';
import DatePicker from '@vuepic/vue-datepicker';
import BaseTable from '~/components/common/BaseTable.vue';
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
const colorMode = useColorMode();
const dateRange = ref([moment().startOf('month').format('YYYY-MM-DD'), moment().endOf('month').format('YYYY-MM-DD')]);

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

function format(dates: Date[]) {
    const fromStr = moment(dates[0]).format('YYYY-MM-DD');
    const toStr = moment(dates[1]).format('YYYY-MM-DD');
    for (const preset of presetDates.value) {
        if (preset.value[0].format('YYYY-MM-DD') === fromStr && preset.value[1].format('YYYY-MM-DD') === toStr) {
            return preset.label;
        }
    }
    return `${fromStr} - ${toStr}`;
}

/** Seconds of working time as people say it: "40 с", "12 мин", "3 ч 05 мин"; no value — a dash. */
function duration(seconds: number | null) {
    if (seconds === null || seconds === undefined) return '—';
    if (seconds < 60) return `${Math.round(seconds)} с`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
    const minutes = Math.round(seconds / 60);
    return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

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
        label: 'Минут разговора',
        name: 'call_minutes',
        icon: 'ph:headset',
        resizable: true,
        sortable: true,
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
    // the field cleared: the API's default, the current month
    if (!dateRange.value?.[0] || !dateRange.value?.[1]) return run(statsService.find().exec());
    run(statsService.find({
        from_date: dateRange.value[0],
        till_date: dateRange.value[1],
    }).exec());
}

watch(dateRange, fetchStats);
onMounted(fetchStats);
</script>

<style>
</style>
