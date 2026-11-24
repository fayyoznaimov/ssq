<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Группы</h1>
            <h2 class="text-sm text-gray-500">
                Отделы сотрудников. Право «Группы» в карточке сотрудника открывает записи всех участников его группы.
            </h2>
        </div>
        <BaseButton color="primary" class="ml-auto" :to="{name: 'settings-groups-id', params: {id: 'new'}}">
            Новая группа
        </BaseButton>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="sorted"
                :loading="isLoading"
                :row-link="(item) => ({name: 'settings-groups-id', params: {id: item.id}})"
                class="flex-auto"
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

/** GET /groups: by name, with the number of staff in the group */
type GroupRow = Group & { users_count?: number };

const groupsService = useService('groups', {auth: true});

const sortBy = ref<Record<string, number>>({name: 1});
const { data: groups, isLoading, run } = useAsync<GroupRow[]>([]);

const columns = ref<Column<GroupRow>[]>([
    {
        label: 'Название',
        name: 'name',
        sortable: true,
        resizable: true,
        rowAnchor: true,
        mobile: 'title',
    },
    {
        label: 'Участников',
        name: 'users_count',
        sortable: true,
        // an API without the count: «—»
        field: (g) => (typeof g.users_count === 'number' ? g.users_count : '—'),
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

const sorted = computed(() => {
    const [column, direction] = Object.entries(sortBy.value)[0] ?? ['name', 1];
    const value = (g: GroupRow) => (column === 'name' ? String(g.name ?? '').toLowerCase()
        : column === 'users_count' ? g.users_count ?? 0 : String((g as any)[column] ?? ''));
    return [...(groups.value ?? [])].sort((a, b) => {
        const x = value(a);
        const y = value(b);
        return (x < y ? -1 : x > y ? 1 : a.id - b.id) * (direction === -1 ? -1 : 1);
    });
});

onMounted(() => {
    run(groupsService.find({limit: 1000}).exec());
});

</script>

<style>
</style>
