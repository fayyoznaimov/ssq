<template>
    <section>
        <header class="mb-5">
            <h1 class="text-xl">
                Записи звонков
            </h1>
            <h2 class="text-sm text-gray-500">
                Список агентов
            </h2>
        </header>

        <main>
            <div class="flex justify-end mb-5">
                <SearchInput
                    v-model="params.search"
                    :debounce="300"
                    @update:model-value="handleSearch"
                />
            </div>

            <!-- Table -->
            <BaseTable
                id="agents"
                v-model:sort-by="sortBy"
                :data="agents?.data"
                :loading="agentsLoading"
                :columns="columns"
                class="flex-auto w-full mb-5"
            />

            <div class="flex items-center justify-between gap-4 mb-5">
                <PerPageSelect
                    :model-value="params.limit"
                    class="flex-shrink-0"
                    @update:model-value="handleLimitUpdate"
                />
                <BasePagination
                    v-if="agents?.count / params.limit > 1"
                    :current-page="params.page"
                    class="w-auto"
                    :item-per-page="params.limit"
                    :total-items="agents?.count"
                    :max-links-displayed="10"
                    shape="rounded"
                    @update:current-page="handlePageUpdate"
                />
            </div>
        </main>
    </section>
</template>

<script lang="ts" setup>
import BasePagination from "~/components/base/BasePagination.vue";
import BaseTable from "~/components/common/BaseTable.vue";
import PerPageSelect from "~/components/common/PerPageSelect.vue";
import SearchInput from "~/components/common/SearchInput.vue";
import type { PaginatedResponse } from "~/types/generics";
import { type User,UserRole } from "~/types/user";

const route = useRoute();

// admin and manager choose whose recordings to listen to (GET /calls/staff/:id lets them); an agent has their own page
const currentUser = useState<User>("user");
if (currentUser.value && currentUser.value.role !== UserRole.Admin && currentUser.value.role !== UserRole.Manager) {
    navigateTo(`/lists/calls/${currentUser.value.id}`, { replace: true });
}

const userService = useService("users", { auth: true });
const sortBy = ref<Record<string, any>>({ id: -1 });

// TODO: Add search functionality
// TODO: Add fix limit change
// TODO: Add fix page change

const params = reactive({
    limit: 10,
    search: undefined,
    page: route.query.page ? Number(route.query.page) : 1,
    role: UserRole.Agent
});

const computedParams = computed(() => ({
    ...params,
    skip: (params.page - 1) * params.limit,
}));

const {
    data: agents,
    run: runAgents,
    isLoading: agentsLoading,
} = useAsync<PaginatedResponse<User>>({
    current_page: computedParams.value.page,
});

const fetchAgents = () => {
    runAgents(userService.find(computedParams.value).exec());
};

fetchAgents();
useLive((changes) => { if (liveTouches(changes, 'calls')) fetchAgents(); }, 1000);

const handleLimitUpdate = (newValue: number) => {
    if (newValue !== params.limit) {
        params.page = 1;
        params.limit = newValue;
        fetchAgents();
    }
};

const handlePageUpdate = (newValue: number) => {
    if (newValue !== agents.value.current_page) {
        params.page = newValue;
        fetchAgents();
    }
};

const handleSearch = () => {
    params.page = 1;
    fetchAgents();
};

const columns = [
    {
        label: "Имя пользователя",
        name: "username",
        resizable: true,
        headerStyle: {
            minWidth: "200px",
        },
        link(value: User) {
            return { name: "lists-calls-id", params: { id: value.id } };
        },
    },
    {
        label: "Компания",
        name: "company",
        resizable: true,
        headerStyle: {
            minWidth: "200px",
        },
        link(value: User) {
            return { name: "lists-calls-id", params: { id: value.id } };
        },
    },
    {
        label: "Телефон",
        name: "phone",
        resizable: true,
        headerStyle: {
            minWidth: "200px",
        },
        link(value: User) {
            return { name: "lists-calls-id", params: { id: value.id } };
        },
    },
    {
        label: "Дата",
        name: "created_at",
        resizable: true,
        headerStyle: {
            minWidth: "200px",
        },
        dateFormat: "DD.MM.YYYY, HH:mm",
        cell(value: User) {
            return value.created_at;
        },
        link(value: User) {
            return { name: "lists-calls-id", params: { id: value.id } };
        },
    },
];

useHead({
    title: "Записи звонков",
});

// no `subject`: an agent who opens /lists/calls lands on their own recordings (above);
// the list of the agents is for admin and manager
definePageMeta({
    authRoute: true,
    layout: "account",
    verbose: "Записи звонков",
});
</script>
