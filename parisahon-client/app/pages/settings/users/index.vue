<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Пользователи</h1>
            <h2 class="text-sm text-gray-500">Список пользователей</h2>
        </div>
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex items-center gap-4">
                <DateSelect
                    v-model:start="dateFilter.start"
                    v-model:end="dateFilter.end"
                    label="Дата создания"
                />
                <PerPageSelect v-model="perPage" />
            </div>
            <NuxtLink
                :to="{name: 'settings-users-id', params: {id: 'new'}}"
                class="border border-gray-300 dark:border-muted-600 rounded-md"
            >
                <BaseButton color="primary">
                    Новый пользователь
                </BaseButton>
            </NuxtLink>
        </div>
        <div>
            <BaseInput
                v-model="username"
                :classes="{wrapper: 'w-full'}"
                icon="ph:list-magnifying-glass"
                placeholder="Поиск"
                size="lg"
            />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="users.data"
                :loading="usersLoading"
                class="flex-auto"
                id="users"
            >
                <template #actions="{item}">
                    <BaseButtonIcon size="sm" :to="{name: 'settings-users-id', params: {id: item.id}}">
                        <Icon
                            class="w-5 h-5"
                            name="ph:pencil-simple"
                        />
                    </BaseButtonIcon>
                </template>
            </BaseTable>
            <BasePagination
                v-if="users.count / perPage > 1"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="users.count"
                :max-links-displayed="10"
                shape="rounded"
            />
        </div>
    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import DateSelect from '~/components/common/DateSelect.vue';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import {type Column} from '~/components/common/types';
import type { User } from '~/types/user';
import {debounce} from '~/utils/search';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Пользователи',
    subject: 'User',
    roles: ['admin'],
});

useHead({
    title: 'Пользователи'
});

const route = useRoute();
const app = useAppConfig();
const usersService = useService('users', {auth: true});

const username = ref('');
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const dateFilter = reactive({start: '', end: ''});
const sortBy = ref<Record<string, any>>({id: -1});
const { data: users, isLoading: usersLoading, run: runUsers } = useAsync<{count: number, data: User[], current_page: number, last_page: number, page_size: number}>({
    data: [], count: 0, current_page: 1, last_page: 1, page_size: perPage.value,
});

const columns = ref<Column[]>([
    {
        label: 'Логин',
        name: 'username',
        sortable: true,
        resizable: true,
    },
    {
        label: 'Email',
        name: 'email',
        sortable: true,
        resizable: true,
    },
    {
        label: 'Роль',
        name: 'role',
        enums: {
            admin: 'Администратор',
            ctr_agent: 'Контр Агент',
            manager: 'Менеджер',
            agent: 'Агент'
        },
        resizable: true,
    },
    {
        label: 'Компания',
        name: 'company',
        object: true,
        resizable: true,
    },
    {
        label: 'Группа',
        name: 'group',
        object: true,
        resizable: true,
    },
    {
        label: 'Дата создания',
        name: 'created_at',
        sortable: true,
        dateFormat: 'MMM Do, HH:mm',
        resizable: true,
    },
    {
        label: '',
        name: 'actions',
        headerStyle: {
            width: '100px'
        }
    }
]);

function fetchUsers() {
    runUsers(usersService.find({
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        sort: sortBy.value,
    }).exec());
}

const searchByUsername = debounce((username: string) => runUsers(usersService.find({username}).exec()), 300);

watch(username, searchByUsername);
watch([currentPage, sortBy, perPage, dateFilter], fetchUsers);
onMounted(fetchUsers);
</script>

<style>
</style>
