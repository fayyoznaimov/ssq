<template>
    <div class="flex flex-col gap-8">
        <h1 class="text-xl">Аналитика по звонкам</h1>
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
import {type Column} from '~/components/common/types';
import type { CallStat } from '~/types/stats';

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
const sortBy = ref<Record<string, any>>({createdAt: -1});

const columns = ref<Column[]>([
    {
        label: 'Имя',
        name: 'user_name',
        resizable: true,
    },
    {
        label: 'Среднее время (мин)',
        name: 'avg_duration',
        resizable: true,
    },
    {
        label: 'Кол-во звонков',
        name: 'call_count',
        resizable: true,
    },
    {
        label: 'Кол-во исходящих',
        name: 'outgoing_call_count',
        resizable: true,
    },
    {
        label: 'Кол-во входящих',
        name: 'incoming_call_count',
        resizable: true,
    },
    {
        label: 'Исходящие (мин)',
        name: 'total_outgoing_duration',
        resizable: true,
    },
    {
        label: 'Входящие (мин)',
        name: 'total_incoming_duration',
        resizable: true,
    },
    {
        label: 'Всего (мин)',
        name: 'total_call_duration',
        resizable: true,
    },
]);

onMounted(() => {
    run(callsService.find().exec());
});
</script>

<style>
</style>
