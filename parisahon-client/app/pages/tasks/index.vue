<template>
    <div>
        <div class="flex flex-col gap-8">
            <div class="px-2">
                <h1 class="text-xl">Задачи</h1>
                <h2 class="text-sm text-gray-500">Список задач</h2>
            </div>
            <div class="flex px-2 flex-wrap gap-5 justify-between">
                <div class="flex flex-wrap items-center gap-4">
                    <!-- the API filters by the task's span (start..deadline), not by the creation date -->
                    <DateSelect
                        v-model:start="filters.fromDate"
                        v-model:end="filters.tillDate"
                        label="Срок"
                    />
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
                    <template #actions="{item}">
                        <BaseButtonIcon size="md" type="button" @click="taskResultModal.open(item)">
                            <Icon class="w-5 h-5" name="ph:pencil-simple" />
                        </BaseButtonIcon>
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

const taskResultModal = useModal('TaskResultModal');
const emits = defineEmits(['fetchTasks']);
const route = useRoute();
const toast = useToast('GlobalToast');
const tasksService = useService('tasks', {auth: true});
const { data: Task, isLoading, runAsync } = useAsync<Task>();

defineProps<{
    filters: TaskFilters;
    tasks: PaginatedResponse<Task>;
    tasksLoading: boolean;
}>();

function memoize(fn: (arg: any) => any) {
    const cache = new WeakMap();
    return (arg: any) => {
        let found = cache.get(arg);
        if (!found) {
            found = fn(arg);
            cache.set(arg, found);
        }

        return found;
    };
}

const isOverdue = memoize((item) => {
    const endAt = moment(item.end);
    return endAt.isBefore(moment()) && !item.closed_at;
});

/** "23.11, 15:00"; an all-day task: the day only. The list rows keep the times as start / end. */
function when(value: string, allDay?: boolean) {
    return formatDate(value, allDay ? 'DD.MM.YYYY' : 'DD.MM.YYYY, HH:mm');
}

const columns = ref<Column[]>([
    {
        // the deadline; sorted by end_time on the server (the default order: the nearest first)
        label: 'Срок',
        name: 'end_time',
        sortable: true,
        field(item) {
            return when(item.end, item.allDay);
        },
        click(item) {
            taskResultModal.open(item);
        },
        classes(item) {
            if (isOverdue(item)) return '!text-red-600';
        },
        resizable: true,
    },
    {
        label: 'Начало',
        name: 'start_time',
        sortable: true,
        field(item) {
            return when(item.start, item.allDay);
        },
        click(item) {
            taskResultModal.open(item);
        },
        classes(item) {
            if (isOverdue(item)) return '!text-red-600';
        },
        resizable: true,
    },
    {
        label: 'Ответственный',
        name: 'agent_id',
        click(item) {
            taskResultModal.open(item);
        },
        // a task of a group: the group is the assignee
        field(item) {
            return item.agent?.username || (item.group ? `Группа «${item.group.name}»` : '');
        },
        classes(item) {
            if (isOverdue(item)) return '!text-red-600';
        },
        resizable: true,
    },
    {
        // the deal first: an automatic task names the deal and its company
        label: 'Объект',
        name: 'object',
        classes(item) {
            let classes = 'underline';
            if (isOverdue(item)) classes += ' !text-red-600';
            else classes += ' !text-blue-600';
            return classes;
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
            let value = '';
            if (item.deal) {
                value = item.deal.label;
            } else if (item.company) {
                value = item.company.name;
            }
            else if (item.ctr_agent) {
                value = item.ctr_agent.username;
            }
            return value;
        },
        subtitle(item) {
            return item.deal && item.company ? item.company.name : '';
        },

        resizable: true,
    },
    {
        label: 'Тип задачи',
        name: 'type',
        click(item) {
            taskResultModal.open(item);
        },
        field(item) {
            return item.type?.name;
        },
        classes(item) {
            if (isOverdue(item)) return '!text-red-600';
        },
        resizable: true,
    },
    {
        label: 'Текст задачи',
        name: 'label',
        click(item) {
            taskResultModal.open(item);
        },
        classes(item) {
            if (isOverdue(item)) return '!text-red-600';
        },
        resizable: true,
    },
    {
        label: 'Результат',
        name: 'result',
        click(item) {
            taskResultModal.open(item);
        },
        classes(item) {
            if (isOverdue(item)) return '!text-red-600';
        },
        resizable: true,
    },
    {
        label: 'Выполнена',
        name: 'closed_at',
        dateFormat: 'DD.MM.YYYY, HH:mm',
        sortable: true,
        click(item) {
            taskResultModal.open(item);
        },
        resizable: true,
    },
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
    taskModal.open(result.value);
}

const taskModal = useModal('TaskModal');

onMounted(() => {
    if (route.query.id) openSingleTask(route.query.id);
    // the list: one page of the filters (the board and the calendar ask for all tasks of their view)
    emits('fetchTasks', {});
});
</script>

<style>
</style>
