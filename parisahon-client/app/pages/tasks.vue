<template>
    <div class="flex flex-col gap-3 min-h-[calc(100vh_-_100px)]">
        <div class="flex flex-wrap justify-between items-center gap-3 mb-4">
            <!-- the three views of the same tasks: an icon and a word each (a phone shows the icons only) -->
            <BaseButtonGroup>
                <BaseButton
                    v-for="view in views"
                    :key="view.to"
                    color="default"
                    :to="{path: view.to, query: listQuery}"
                    :title="view.label"
                    :class="route.path === view.to ? '!bg-muted-200 dark:!bg-muted-600' : ''"
                >
                    <Icon :name="view.icon" class="size-5" />
                    <span class="xs:hidden">{{ view.label }}</span>
                </BaseButton>
            </BaseButtonGroup>
            <!-- whose tasks: mine (me or my group) by default, the ones I gave, everybody's -->
            <BaseButtonGroup class="flex-wrap">
                <BaseButton
                    v-for="option in scopes"
                    :key="option.value"
                    color="default"
                    :class="scope === option.value ? 'toggle-selected' : ''"
                    @click="scope = option.value"
                >
                    {{ option.label }}
                </BaseButton>
            </BaseButtonGroup>
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
                                placeholder="Открытые"
                            />

                            <BaseListbox
                                v-model="filters.assignedTo"
                                label="Исполнители"
                                rounded="md"
                                :items="employees"
                                :properties="{
                                    value: 'id',
                                    label: 'username',
                                }"
                                :loading="usersLoading"
                                placeholder="Все исполнители"
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
            @saved="loadTaskTypes"
        />
    </div>
</template>

<script setup lang="ts">
import BaseButton from "~/components/base/BaseButton.vue";
import BaseButtonGroup from "~/components/base/BaseButtonGroup.vue";
import TairoPopover from "~/components/tairo/TairoPopover.vue";
import TaskTypeManageModal from "~/components/task/TaskTypeManageModal.vue";
import type { Task, TaskFilters, TaskType } from "~/types/deal";
import type { PaginatedResponse } from "~/types/generics";
import type { Stage } from "~/types/stage";
import { type User,UserRole } from "~/types/user";

const commonStore = useCommonStore();
const { notificationCount } = storeToRefs(commonStore);

// "Открытые" is what the API gives without a status; "Все статусы" really is all of them now
const statuses = [
    {
        label: "Открытые",
        value: "open",
    },
    {
        label: "Просроченные",
        value: "overdue",
    },
    {
        // open and not overdue: «Задачи к выполнению» of the desktop
        label: "Предстоящие",
        value: "upcoming",
    },
    {
        label: "Закрытые",
        value: "closed",
    },
    {
        label: "Все статусы",
        value: "all",
    }
];

type Scope = "mine" | "created" | "all";
const scopes: {label: string, value: Scope}[] = [
    { label: "Мои", value: "mine" },
    { label: "Поставил я", value: "created" },
    { label: "Все", value: "all" },
];

const allTaskTypes = {
    id: -1,
    name: "Все типы",
};

const app = useAppConfig();
const route = useRoute();

const views = [
    { to: "/tasks", label: "Список", icon: "ph:list" },
    { to: "/tasks/kanban", label: "Канбан", icon: "ph:kanban" },
    { to: "/tasks/calendar", label: "Календарь", icon: "ph:calendar-blank" },
];

// a link from the desktop keeps its filters when the view changes
const listQuery = computed(() => {
    const {page, id, ...rest} = route.query;
    return rest;
});

/** The list filters plus the dates a link may bring: when the tasks were set and when they were done. */
type ListFilters = TaskFilters & {
    createdFrom: string;
    createdTill: string;
    closedFrom: string;
    closedTill: string;
};

const queryText = (key: string) => {
    const value = route.query[key];
    return typeof value === "string" ? value : "";
};

// links from the desktop and the reports: ?status=overdue&scope=mine, ?user_id=5&username=..., ?type_id=..,
// ?from=2026-11-01&till=2026-11-23 (the deadline span touches these days), ?closed_from=..&closed_till=..
const queryUserIds = [route.query.user_id].flat().filter(Boolean).map((id) => Number(id));

const initialFilters: ListFilters = {
    stages: [],
    assignedTo: [],
    createdBy: [],
    status: statuses.find((s) => s.value === route.query.status) ?? statuses[0],
    taskType: allTaskTypes,
    perPage: app.pagination.defaultPageSize,
    currentPage: route.query.page ? parseInt(route.query.page as string) : 1,
    // the nearest deadline first
    sortBy: {end_time: 1},
    fromDate: queryText("from"),
    tillDate: queryText("till"),
    createdFrom: "",
    createdTill: "",
    closedFrom: queryText("closed_from"),
    closedTill: queryText("closed_till"),
};

const filters = reactive<ListFilters>({
    ...initialFilters,
    ...(route.query.type_id && {taskType: {id: Number(route.query.type_id), name: route.query.type_name} as TaskType}),
    ...(queryUserIds.length && {assignedTo: queryUserIds.map((id) => ({id, username: queryUserIds.length === 1 ? route.query.username : ""}) as User)}),
});

// a link with chosen people shows their tasks; otherwise "Мои" unless the link says otherwise
const scope = ref<Scope>(
    scopes.some((s) => s.value === route.query.scope) ? route.query.scope as Scope : (queryUserIds.length ? "all" : "mine"),
);

const currentUser = useState<User>("user");
const stageService = useService("stages", {auth: true});
const taskTypeService = useService("task-types", {auth: true});
const userService = useService("users", {auth: true});
const staffService = useService("users/staff", {auth: true});
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

// people from a link come with ids only: their names once the staff list is there
watch(employees, (list) => {
    if (!filters.assignedTo.some((a) => !a.username)) return;
    filters.assignedTo = filters.assignedTo.map((a) => a.username ? a : (list.find((e) => e.id === a.id) ?? a));
});

/** Staff accounts for the filters, former employees too (GET /users/staff); an older API: users minus contacts. */
async function staffUsers(): Promise<PaginatedResponse<User>> {
    try {
        return await staffService.find<PaginatedResponse<User>>({with_deleted: true}).exec();
    } catch (e) {
        return await userService.find<PaginatedResponse<User>>({limit: 1000}).exec();
    }
}

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

/**
 * The page (list, board, calendar) adds its own part of the query and it is kept for the next loads
 * (a filter, a live update, a saved task): the calendar its dates, the board all open tasks, the list
 * its page; `all: true` — every page of the result (allPages). Before, a changed filter dropped it and the calendar showed the first 25 tasks of all.
 */
let viewQuery: Record<string, any> = {};

function fetchTasks(view?: Record<string, any>) {
    if (view !== undefined) viewQuery = view;
    const query: Record<string, any> = {
        skip: (filters.currentPage - 1) * filters.perPage,
        limit: filters.perPage,
        sort: filters.sortBy,
    };

    if (filters.fromDate && filters.tillDate) {
        query.from_date = filters.fromDate;
        query.till_date = filters.tillDate;
    }

    if (filters.createdFrom && filters.createdTill) {
        query.created_from = filters.createdFrom;
        query.created_till = filters.createdTill;
    }

    if (filters.closedFrom) query.closed_from = filters.closedFrom;
    if (filters.closedTill) query.closed_till = filters.closedTill;

    if (filters.stages.length) {
        query.stage_ids = filters.stages.map((s) => s.id);
    }

    if (filters.assignedTo.length) {
        query.assigned_to = filters.assignedTo.map((a) => a.id);
    }

    if (filters.createdBy.length) {
        query.created_by = filters.createdBy.map((a) => a.id);
    }

    // without a status the API gives the open tasks
    if (filters.status.value !== "open") {
        query.type = filters.status.value;
    }

    if (filters.taskType.id > 0) {
        query.type_id = filters.taskType.id;
    }

    if (scope.value === "mine") {
        query.mine = true;
    } else if (scope.value === "created" && currentUser.value?.id) {
        query.created_by = [currentUser.value.id];
    }

    const {all, ...viewPart} = viewQuery;
    runTasks(all ? allPages({...query, ...viewPart}) : tasksService.find({...query, ...viewPart}).exec());
}

/**
 * The board and the calendar show every task of their view, not one page: pages of 500 one after
 * another (up to 5000 tasks; past that the board says it shows a part).
 */
const PAGE = 500;
const MAX_TASKS = 5000;
let loadRun = 0;

async function allPages(query: Record<string, any>): Promise<PaginatedResponse<Task>> {
    const run = ++loadRun;
    const first = await tasksService.find<PaginatedResponse<Task>>({...query, skip: 0, limit: PAGE}).exec();
    const data = [...first.data];
    while (data.length < first.count && data.length < MAX_TASKS && run === loadRun) {
        const next = await tasksService.find<PaginatedResponse<Task>>({...query, skip: data.length, limit: PAGE}).exec();
        if (!next.data.length) break;
        data.push(...next.data);
    }
    return {...first, data, page_size: data.length, current_page: 1, last_page: 1};
}

watch(filters, () => fetchTasks());
watch(scope, () => fetchTasks());
// live: tasks created / closed by others (and by triggers) show up by themselves
useLive((changes) => { if (liveTouches(changes, "tasks")) fetchTasks(); });

function loadTaskTypes() {
    runTaskTypes(taskTypeService.find().exec()).then(() => {
        taskTypes.value.unshift(allTaskTypes);
    });
}

onMounted(() => {
    loadTaskTypes();
    runStages(stageService.find().exec());
    runUsers(staffUsers());

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
