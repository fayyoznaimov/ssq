<template>
    <div class="flex flex-col gap-3 min-h-[calc(100vh_-_100px)]">
        <div class="flex flex-wrap justify-between items-center gap-3 mb-4">
            <nav>
                <ul class="flex items-center gap-3">
                    <li>
                        <NuxtLink
                            class="p-1"
                            exact-active-class="text-blue-600"
                            to="/tasks"
                        >
                            <Icon
                                name="ph:list"
                                class="text-inherit size-6"
                            />
                        </NuxtLink>
                    </li>
                    <li>
                        <NuxtLink
                            to="/tasks/kanban"
                            class="p-1"
                            exact-active-class="text-blue-600"
                        >
                            <Icon
                                name="ph:kanban"
                                class="text-inherit size-6"
                            />
                        </NuxtLink>
                    </li>
                    <li>
                        <NuxtLink
                            class="p-1"
                            exact-active-class="text-blue-600"
                            to="/tasks/calendar"
                        >
                            Календарь
                        </NuxtLink>
                    </li>
                </ul>
            </nav>
            <div class="flex flex-wrap gap-2 items-center">
                <!-- <Filter @filter="handleFilter" /> -->
                <TairoPopover
                    fixed
                    size="2md"
                    orientation="end"
                >
                    <BaseButton>
                        <Icon name="ph:funnel" />
                    </BaseButton>

                    <template #content>
                        <div class="flex flex-col p-4">
                            <BaseListbox
                                v-model="filters.taskType"
                                label="Тип"
                                rounded="md"
                                :items="taskTypes"
                                :properties="{
                                    value: 'id',
                                    label: 'name',
                                }"
                                :loading="taskTypesLoading"
                                placeholder="Все типы"
                                clearable
                            />

                            <BaseListbox
                                v-model="filters.stages"
                                label="Этапы"
                                rounded="md"
                                :items="stages"
                                :properties="{
                                    value: 'id',
                                    label: 'name',
                                }"
                                :loading="stagesLoading"
                                placeholder="Все этапы"
                                multiple
                                :multiple-label="(value, prop) => {
                                    if (!value.length) return;
                                    else return `${value.map(v => v[prop]).join(', ')}`;
                                }"
                            />

                            <BaseListbox
                                v-model="filters.status"
                                label="Статус"
                                rounded="md"
                                :items="statuses"
                                :properties="{
                                    value: 'value',
                                    label: 'label',
                                }"
                                placeholder="Все статусы"
                            />

                            <BaseListbox
                                v-model="filters.assignedTo"
                                label="Менеджеры"
                                rounded="md"
                                :items="employees"
                                :properties="{
                                    value: 'id',
                                    label: 'username',
                                }"
                                :loading="usersLoading"
                                placeholder="Все менеджеры"
                                multiple
                                :multiple-label="(value, prop) => {
                                    if (!value.length) return;
                                    else return `${value.map(v => v[prop]).join(', ')}`;
                                }"
                            />

                            <BaseListbox
                                v-model="filters.createdBy"
                                label="Создан"
                                rounded="md"
                                :items="employees"
                                :properties="{
                                    value: 'id',
                                    label: 'username',
                                }"
                                :loading="usersLoading"
                                placeholder="Все"
                                multiple
                                :multiple-label="(value, prop) => {
                                    if (!value.length) return;
                                    else return `${value.map(v => v[prop]).join(', ')}`;
                                }"
                            />
                        </div>
                    </template>
                </TairoPopover>
                <div class="flex justify-start">
                    <!-- task types are created and changed by admin only (API: @Roles(ADMIN_LEVEL)) -->
                    <BaseDropdown
                        v-if="currentUser?.role === UserRole.Admin"
                        variant="context"
                        label="Dropdown"
                        placement="bottom-start"
                    >
                        <BaseDropdownItem
                            title="Управление типами задач"
                            class="hover:bg-muted-100 rounded-md duration-300 dark:hover:bg-muted-900"
                            @click="taskTypeModal.open"
                        />
                    </BaseDropdown>
                </div>
                <BaseButton
                    class="shrink-0"
                    @click="onNewTask"
                >
                    Новая задача
                </BaseButton>
            </div>
        </div>
        <nuxt-page
            :tasks="tasks"
            :filters="filters"
            :tasks-loading="tasksLoading"
            @fetch-tasks="fetchTasks"
        />
        <TaskTypeManageModal
            id="TaskTypeManageModal"
            :task-types="taskTypes"
        />
    </div>
</template>

<script setup lang="ts">
import BaseButton from "~/components/base/BaseButton.vue";
import TairoPopover from "~/components/tairo/TairoPopover.vue";
import TaskTypeManageModal from "~/components/task/TaskTypeManageModal.vue";
import type { Task, TaskFilters, TaskType } from "~/types/deal";
import type { PaginatedResponse } from "~/types/generics";
import type { Stage } from "~/types/stage";
import { type User,UserRole } from "~/types/user";

const commonStore = useCommonStore();
const { notificationCount } = storeToRefs(commonStore);

const statuses = [
    {
        label: "Все статусы",
        value: "all",
    },
    {
        label: "Просроченные",
        value: "overdue",
    },
    {
        label: "Закрытые",
        value: "closed",
    }
];

const allTaskTypes = {
    id: -1,
    name: "Все типы",
};

const app = useAppConfig();
const route = useRoute();

const initialFilters: TaskFilters = {
    stages: [],
    assignedTo: [],
    createdBy: [],
    status: statuses[0],
    taskType: allTaskTypes,
    perPage: app.pagination.defaultPageSize,
    currentPage: route.query.page ? parseInt(route.query.page as string) : 1,
    sortBy: {id: -1},
    fromDate: "",
    tillDate: "",
};

const filters = reactive<TaskFilters>({
    ...initialFilters,
    ...(route.query.type_id && {taskType: {id: Number(route.query.type_id), name: route.query.type_name} as TaskType}),
    ...(route.query.user_id && {assignedTo: [{id: Number(route.query.user_id), username: route.query.username} as User]}),
});

const currentUser = useState<User>("user");
const stageService = useService("stages", {auth: true});
const taskTypeService = useService("task-types", {auth: true});
const userService = useService("users", {auth: true});
const tasksService = useService("tasks", {auth: true});

const { run: runStages, isLoading: stagesLoading, data: stages } = useAsync<Stage[]>([]);
const { run: runTaskTypes, isLoading: taskTypesLoading, data: taskTypes } = useAsync<TaskType[]>([]);
const { run: runUsers, data: users, isLoading: usersLoading } = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});

const { data: tasks, isLoading: tasksLoading, run: runTasks } = useAsync<PaginatedResponse<Task>>({
    data: [],
    count: 0,
    page_size: filters.perPage,
    current_page: 0,
    last_page: 0
});

const taskModal = useModal("TaskModal");
const taskTypeModal = useModal("TaskTypeManageModal");

const employees = computed(() => {
    return users.value.data.filter((u) => u.role !== UserRole.CtrAgent);
});

function onNewTask() {
    const end = new Date();
    const start = new Date().toISOString();
    end.setMinutes(end.getMinutes() + 30);
    const endStr = end.toISOString();
    taskModal.open({
        id: -1,
        label:  "",
        result: null,
        closed_at: "",
        start_time: start,
        start: start,
        end: endStr,
        end_time: endStr,
        created_at: new Date().toISOString(),
        allDay: false
    });
}

function fetchTasks(additional: any = {}) {
    const query: Record<string, any> = {
        skip: (filters.currentPage - 1) * filters.perPage,
        limit: filters.perPage,
        sort: filters.sortBy,
    };

    if (filters.fromDate && filters.tillDate) {
        query.from_date = filters.fromDate;
        query.till_date = filters.tillDate;
    }

    if (filters.stages.length) {
        query.stage_ids = filters.stages.map((s) => s.id);
    }

    if (filters.assignedTo.length) {
        query.assigned_to = filters.assignedTo.map((a) => a.id);
    }

    if (filters.createdBy.length) {
        query.created_by = filters.createdBy.map((a) => a.id);
    }

    if (filters.stages.length) {
        query.stage_ids = filters.stages.map((s) => s.id);
    }

    if (filters.status.value !== "all") {
        query.type = filters.status.value;
    }

    if (filters.taskType.id > 0) {
        query.type_id = filters.taskType.id;
    }

    runTasks(tasksService.find({...query, ...additional}).exec());
}

watch(filters, fetchTasks);
// live: tasks created / closed by others (and by triggers) show up by themselves
useLive((changes) => { if (liveTouches(changes, "tasks")) fetchTasks(); });

onMounted(() => {
    runTaskTypes(taskTypeService.find().exec()).then(() => {
        taskTypes.value.unshift(allTaskTypes);
    });
    runStages(stageService.find().exec());
    runUsers(userService.find({limit: 1000}).exec());

    notificationCount.value = 0;
});

definePageMeta({
    authRoute: true,
    layout: "account",
    verbose: "Задачи",
    subject: "Task"
});

useHead({
    title: "Задачи"
});
</script>

<style scoped>

</style>
