<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Транспортеры</h1>
            <h2 class="text-sm text-gray-500">Список транспортеров</h2>
        </div>
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex items-center gap-4">
            </div>
            <NuxtLink
                :to="{name: 'settings-transporters-id', params: {id: 'new'}}"
                class="border border-gray-300 dark:border-muted-600 rounded-md"
            >
                <BaseButton color="primary">
                    Новый транспортер
                </BaseButton>
            </NuxtLink>
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                :columns="columns"
                :data="transporters"
                :loading="isLoading"
                :sort-by="[]"
                class="flex-auto"
                id="transporters"
            >
                <template #actions="{item}">
                    <BaseButtonIcon size="sm" :to="{name: 'settings-transporters-id', params: {id: item.id}}">
                        <Icon
                            class="w-5 h-5"
                            name="ph:pencil-simple"
                        />
                    </BaseButtonIcon>
                </template>
            </BaseTable>
        </div>
    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import {type Column} from '~/components/common/types';
import { useAsync } from '~/composables/useAsync';

type Transporter = {
    id: number;
    email: string;
    created_at: string;
}

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Транспортеры',
    roles: ['admin'],
    subject: 'Mail'
});

useHead({
    title: 'Транспортеры'
});

const transporterService = useService('emails/transporters', {auth: true});
const { data: transporters, isLoading, run } = useAsync<Transporter[]>([]);
const columns = ref<Column[]>([
    {
        label: 'Почта',
        name: 'email',
        resizable: true,
        headerStyle: {
            minWidth: '200px',
        }
    },
    {
        label: 'Дата создания',
        name: 'created_at',
        dateFormat: 'MMM Do, HH:mm',
        headerStyle: {
            minWidth: '200px',
        }
    },
    {
        label: '',
        name: 'actions',
        headerStyle: {
            width: '100px'
        }
    }
]);

onMounted(() => {
    run(transporterService.find().exec());
});
</script>

<style>
</style>
