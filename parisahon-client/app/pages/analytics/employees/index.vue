<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <div>
                <h1 class="text-xl">Аналитика по сотрудникам</h1>
                <h2 class="text-sm text-gray-500">Сделки (ответственный) и задачи (исполнитель), созданные за период</h2>
            </div>
            <PeriodPicker v-model="period" />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="stats"
                :loading="isLoading"
                class="flex-auto"
                id="employee-analytics"
            >
            </BaseTable>
        </div>

    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import PeriodPicker from '~/components/analytics/PeriodPicker.vue';
import {type Column} from '~/components/common/types';
import type { UserStat } from '~/types/stats';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'По сотрудникам'
});

useHead({
    title: 'По сотрудникам'
});

const userService = useService('analytics/users', {auth: true});

const { data: stats, isLoading, run } = useAsync<UserStat[]>([]);
const sortBy = ref<Record<string, any>>({});
const { period, bounds } = useReportPeriod('month');

const columns = ref<Column[]>([
    {
        label: 'Имя',
        name: 'username',
        resizable: true,
    },
    {
        label: 'Сделок',
        name: 'deal_count',
        resizable: true,
    },
    {
        label: 'Сумма сделок',
        name: 'deal_budget',
        resizable: true,
        money: true
    },
    {
        label: 'Задач',
        name: 'task_count',
    },
]);

function fetchStats() {
    // the API needs both dates: «за всё время» goes as the far ends
    run(userService.find(bounds.value).exec());
}

watch(period, fetchStats);
onMounted(fetchStats);
</script>

<style>
</style>
