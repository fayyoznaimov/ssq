<template>
    <div>
        <div class="flex flex-col gap-8">
            <div class="px-2">
                <h1 class="text-xl">Задачи</h1>
                <h2 class="text-sm text-gray-500">Список задач</h2>
            </div>
            <div class="flex px-2 flex-wrap gap-5 justify-between">
                <div class="flex flex-wrap items-center gap-4">
                    <!-- «Срок»: the task's span (start..deadline) touches these days; «Создана»: when it was set -->
                    <DateSelect
                        v-model:start="filters.fromDate"
                        v-model:end="filters.tillDate"
                        label="Срок"
                    />
                    <DateSelect
                        v-model:start="filters.createdFrom"
                        v-model:end="filters.createdTill"
                        label="Создана"
                    />
                    <!-- a link from the desktop: the tasks done in its period -->
                    <BaseButton
                        v-if="filters.closedFrom || filters.closedTill"
                        title="Снять фильтр"
                        @click="clearClosed"
                    >
                        Выполнены {{ closedPeriod }}
                        <Icon name="ph:x" class="ms-1" />
                    </BaseButton>
                    <PerPageSelect v-model="filters.perPage" />
                </div>
            </div>
            <div class="relative overflow-x-auto">
                <BaseTable
                    v-model:sortBy="filters.sortBy"
                    :columns="columns"
                    :data="tasks.data"
                    :loading="tasksLoading"
                    class="flex-auto"
                    id="tasks"
                >
                    <!-- the deadline; an overdue one says by how much (only this cell is red, not the row) -->
                    <template #end_time="{item}">
                        <button type="button" class="text-left" @click="taskModal.open(item)">
                            <span :class="isTaskOverdue(item) ? 'text-red-600 dark:text-red-400 font-medium' : ''">
                                {{ taskWhen(item.end, item.allDay) }}
                            </span>
                            <span
                                v-if="isTaskOverdue(item)"
                                class="block w-max mt-0.5 rounded px-1.5 py-0.5 text-xs bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                            >{{ overdueText(item) }}</span>
                        </button>
                    </template>
                    <template #actions="{item}">
                        <div class="flex gap-1 justify-end">
                            <BaseButtonIcon
                                v-if="!item.closed_at"
                                size="md"
                                type="button"
                                title="Выполнить"
                                @click="taskResultModal.open(item)"
                            >
                                <Icon class="w-5 h-5 text-green-600" name="ph:check" />
                            </BaseButtonIcon>
                            <BaseButtonIcon size="md" type="button" title="Изменить" @click="taskModal.open(item)">
                                <Icon class="w-5 h-5" name="ph:pencil-simple" />
                            </BaseButtonIcon>
                        </div>
                    </template>
                </BaseTable>
                <BasePagination
                    v-if="tasks.count / filters.perPage > 1"
                    v-model:current-page="filters.currentPage"
                    class="my-2"
                    :item-per-page="filters.perPage"
                    :total-items="tasks.count"
                    :max-links-displayed="10"
                    shape="rounded"
                />
            </div>
        </div>
        <TaskModal
            id="TaskModal"
            @save="emits('fetchTasks')"
        />
        <TaskResultModal id="TaskResultModal" @saved="emits('fetchTasks')" />
    </div>
</template>

<script lang="ts" setup>
import moment from 'moment';
import type { LocationQueryValue } from 'vue-router';

import BaseTable from '~/components/common/BaseTable.vue';
import DateSelect from '~/components/common/DateSelect.vue';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import type { Column } from '~/components/common/types';
import TaskModal from '~/components/task/TaskModal.vue';
import TaskResultModal from '~/components/task/TaskResultModal.vue';
import { isTaskOverdue, overdueText, taskSubject, taskWhen } from '~/components/task/taskText';
import type { Task, TaskFilters } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Задачи',
    subject: 'Task'
});

useHead({
    title: 'Задачи'
});

/** The list filters of pages/tasks.vue: the deadline, creation and done dates too. */
type ListFilters = TaskFilters & { createdFrom?: string; createdTill?: string; closedFrom?: string; closedTill?: string };

const taskResultModal = useModal('TaskResultModal');
const taskModal = useModal('TaskModal');
const emits = defineEmits(['fetchTasks']);
const route = useRoute();
const toast = useToast('GlobalToast');
const tasksService = useService('tasks', {auth: true});
const { runAsync } = useAsync<Task>();

const props = defineProps<{
    filters: ListFilters;
    tasks: PaginatedResponse<Task>;
    tasksLoading: boolean;
}>();

const closedPeriod = computed(() => {
    const day = (v?: string) => (v ? moment(v).format('DD.MM') : '…');
    return `${day(props.filters.closedFrom)}–${day(props.filters.closedTill)}`;
});

function clearClosed() {
    props.filters.closedFrom = '';
    props.filters.closedTill = '';
}

// «Результат» and «Выполнена» only where closed tasks are listed (they are empty for open ones)
const showsClosed = computed(() => ['closed', 'all'].includes(props.filters.status?.value));

const columns = computed<Column[]>(() => [
    {
        // the deadline (the cell is the slot above); sorted by end_time on the server, the nearest first
        label: 'Срок',
        name: 'end_time',
        sortable: true,
        resizable: true,
    },
    {
        label: 'Текст задачи',
        name: 'label',
        mobile: 'title',
        wrap: true,
        click(item) {
            taskModal.open(item);
        },
        resizable: true,
    },
    {
        // the deal first: an automatic task names the deal and its company
        label: 'Объект',
        name: 'object',
        classes() {
            return 'underline !text-blue-600 dark:!text-blue-400';
        },
        link(item) {
            let link = '';
            if (item.deal) {
                link = `/deals/${item.deal.id}`;
            } else if (item.company) {
                link = `/lists/companies/${item.company.id}`;
            } else if (item.ctr_agent) {
                link = `/lists/contacts/${item.ctr_agent.id}`;
            }
            return link;
        },
        field(item) {
            return taskSubject(item);
        },
        subtitle(item) {
            return item.deal && item.company ? item.company.name : '';
        },
        resizable: true,
    },
    {
        label: 'Ответственный',
        name: 'agent_id',
        click(item) {
            taskModal.open(item);
        },
        // a task of a group: the group is the assignee
        field(item) {
            return item.agent?.username || (item.group ? `Группа «${item.group.name}»` : '');
        },
        resizable: true,
    },
    {
        label: 'Тип задачи',
        name: 'type',
        click(item) {
            taskModal.open(item);
        },
        field(item) {
            return item.type?.name ?? 'Задача';
        },
        resizable: true,
    },
    {
        label: 'Начало',
        name: 'start_time',
        sortable: true,
        field(item) {
            return taskWhen(item.start, item.allDay);
        },
        click(item) {
            taskModal.open(item);
        },
        resizable: true,
    },
    ...(showsClosed.value ? [
        {
            label: 'Результат',
            name: 'result',
            wrap: true,
            resizable: true,
        },
        {
            label: 'Выполнена',
            name: 'closed_at',
            sortable: true,
            field(item: Task) {
                return item.closed_at ? taskWhen(item.closed_at) : '';
            },
            resizable: true,
        },
    ] as Column[] : []),
    {
        label: '',
        name: 'actions',
        headerStyle: { width: '100px' },
    }
]);


async function openSingleTask(val: string | LocationQueryValue[]) {
    const id = Array.isArray(val) ? val[0] : val;
    if (!id) return;
    const result = await promiseResult(runAsync(tasksService.get(id).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    // GET /tasks/:id names the times start_time / end_time, the list start / end
    const task = result.value as Task;
    taskModal.open({...task, start: task.start ?? task.start_time, end: task.end ?? task.end_time});
}

onMounted(() => {
    if (route.query.id) openSingleTask(route.query.id);
    // the list: one page of the filters (the board and the calendar ask for all tasks of their view)
    emits('fetchTasks', {});
});
</script>

<style>
</style>
