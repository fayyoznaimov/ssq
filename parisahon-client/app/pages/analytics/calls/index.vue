<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <h1 class="text-xl">Аналитика по звонкам</h1>
            <PeriodPicker v-model="period" />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="sorted"
                :loading="isLoading"
                class="flex-auto"
                id="call-analytics"
            >
            </BaseTable>
        </div>
        <p v-if="!isLoading && !stats.length" class="text-sm text-muted-500">
            За этот период записей звонков нет. Записи приходят с телефонов менеджеров (Настройки → Звонки).
        </p>
        <p class="text-sm text-muted-500">
            Звонки — записи звонков за период по времени самого звонка, как в «Контроле» и «По менеджерам». Длительность — минуты:секунды.
        </p>
    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import PeriodPicker from '~/components/analytics/PeriodPicker.vue';
import {type Column} from '~/components/common/types';
import type { CallStat } from '~/types/stats';
import { clock, spoken } from '~/utils/duration';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'По звонкам'
});

useHead({
    title: 'По звонкам'
});

const callsService = useService('analytics/calls', {auth: true});

const { data: stats, isLoading, run } = useAsync<CallStat[]>([]);
const sortBy = ref<Record<string, number>>({});
// the same default as «Контроль» and «По менеджерам»: the current month (or the period chosen in another report)
const { period, params } = useReportPeriod('month');

// seconds from the API; an older API sends minutes only
const sec = (item: any, key: string, minutesKey: string) =>
    item[key] !== undefined && item[key] !== null ? Number(item[key]) : Math.round(Number(item[minutesKey] ?? 0) * 60);

const columns = ref<Column<CallStat>[]>([
    {
        label: 'Сотрудник',
        name: 'user_name',
        resizable: true,
        sortable: true,
    },
    {
        label: 'Звонков',
        name: 'call_count',
        resizable: true,
        sortable: true,
    },
    {
        label: 'Исходящих',
        name: 'outgoing_call_count',
        resizable: true,
        sortable: true,
    },
    {
        label: 'Входящих',
        name: 'incoming_call_count',
        resizable: true,
        sortable: true,
    },
    {
        label: 'Средний звонок',
        name: 'avg_duration_sec',
        resizable: true,
        sortable: true,
        field: (item) => clock(sec(item, 'avg_duration_sec', 'avg_duration')),
    },
    {
        label: 'Исходящие, всего',
        name: 'total_outgoing_sec',
        resizable: true,
        sortable: true,
        field: (item) => spoken(sec(item, 'total_outgoing_sec', 'total_outgoing_duration')),
    },
    {
        label: 'Входящие, всего',
        name: 'total_incoming_sec',
        resizable: true,
        sortable: true,
        field: (item) => spoken(sec(item, 'total_incoming_sec', 'total_incoming_duration')),
    },
    {
        label: 'Всего',
        name: 'total_call_sec',
        resizable: true,
        sortable: true,
        field: (item) => spoken(sec(item, 'total_call_sec', 'total_call_duration')),
    },
]);

// sorted by the raw value of the column (seconds, counts), not by its text
const sorted = computed(() => {
    const rows = [...(stats.value ?? [])];
    const [key, order] = Object.entries(sortBy.value)[0] ?? [];
    if (!key) return rows;
    return rows.sort((a: any, b: any) => {
        const x = typeof a[key] === 'string' && key !== 'user_name' ? Number(a[key]) : a[key];
        const y = typeof b[key] === 'string' && key !== 'user_name' ? Number(b[key]) : b[key];
        if (x === y) return 0;
        const less = typeof x === 'string' ? x.localeCompare(y, 'ru') < 0 : x < y;
        return (less ? -1 : 1) * (order === -1 ? -1 : 1);
    });
});

function fetchStats() {
    run(callsService.find(params.value).exec());
}

watch(period, fetchStats);
onMounted(fetchStats);
</script>
