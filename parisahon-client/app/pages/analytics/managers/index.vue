<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Аналитика по менеджерам</h1>
            <h2 class="text-sm text-gray-500">Список менеджеров</h2>
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="stats"
                :loading="isLoading"
                class="flex-auto"
                id="manager-analytics"
            >
            </BaseTable>
        </div>
    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import {type Column} from '~/components/common/types';
import type { AgentStat } from '~/types/user';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'По менеджерам'
});

useHead({
    title: 'По менеджерам'
});

const statsService = useService('users/manager-statistics', {auth: true});

const { data: stats, isLoading, run } = useAsync<AgentStat[]>([]);
const sortBy = ref<Record<string, any>>({createdAt: -1});

const columns = ref<Column[]>([
    {
        label: 'Имя',
        name: 'username',
        icon: 'ph:identification-card',
        resizable: true,
    },
    {
        label: 'Почта',
        name: 'email',
        icon: 'ph:envelope-simple',
        resizable: true,
    },
    {
        label: 'Номер телефона',
        name: 'phone',
        icon: 'ph:phone',
        resizable: true,
    },
    {
        label: 'Кол-во сделок',
        name: 'deal_count',
        icon: 'ph:handshake',
        resizable: true,
    },
    {
        label: 'Средний бюджет',
        name: 'average_budget',
        icon: 'ph:money',
        resizable: true,
    },
    {
        label: 'Кол-во новых клиентов',
        name: 'new_client_count',
        icon: 'ph:user-plus',
        resizable: true,
    },
    {
        label: 'Общая продолжительность разговора',
        name: 'total_call_duration',
        icon: 'ph:headset',
        resizable: true,
    },
    {
        label: 'Среднее время отклика (TG)',
        name: 'average_telegram_response_time',
        icon: 'ph:paper-plane-tilt',
        resizable: true,
    },
    {
        label: 'Среднее время отклика (E-Mail)',
        name: 'average_email_response_time',
        icon: 'ph:envelope-simple-open',
    },
]);

onMounted(() => {
    run(statsService.find().exec());
});
</script>

<style>
</style>
