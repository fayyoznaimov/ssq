<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Группы</h1>
            <h2 class="text-sm text-gray-500">Список групп</h2>
        </div>
        <NuxtLink
            :to="{name: 'settings-groups-id', params: {id: 'new'}}"
            class="border border-gray-300 dark:border-muted-600 rounded-md ml-auto"
        >
            <BaseButton color="primary">
                Новая группа
            </BaseButton>
        </NuxtLink>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="groups"
                :loading="isLoading"
                class="flex-auto"
                :buttons="true"
                id="groups"
            >
                <template #actions="{item}">
                    <BaseButtonIcon size="sm" :to="{name: 'settings-groups-id', params: {id: item.id}}">
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
import type {Group} from '~/types/user';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Группы',
    subject: 'Group'
});

useHead({
    title: 'Группы'
});

const groupsService = useService('groups', {auth: true});

const sortBy = ref<Record<string, any>>({createdAt: -1});
const { data: groups, isLoading, run } = useAsync<Group[]>([]);

const columns = ref<Column[]>([
    {
        label: 'Название',
        name: 'name',
        sortable: true,
        resizable: true,
    },
    {
        label: 'Дата создания',
        name: 'created_at',
        sortable: true,
        resizable: true,
        dateFormat: 'MMM Do, HH:mm',
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
    run(groupsService.find({limit: 1000}).exec());
});

</script>

<style>
</style>
