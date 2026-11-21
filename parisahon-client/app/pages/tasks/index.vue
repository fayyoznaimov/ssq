<template>
    <div>
        <div class="flex flex-col gap-8">
            <div class="px-2">
                <h1 class="text-xl">Задачи</h1>
                <h2 class="text-sm text-gray-500">Список задач</h2>
            </div>
            <div class="flex px-2 flex-wrap gap-5 justify-between">
                <div class="flex flex-wrap items-center gap-4">
                    <DateSelect
                        v-model:start="filters.fromDate"
                        v-model:end="filters.tillDate"
                        label="Дата создания"
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

const columns = ref<Column[]>([
    {
        label: 'Дата исполнения',
        name: 'closed_at',
        dateFormat: 'MMM Do, HH:mm',
        sortable: true,
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
        field(item) {
            return item.agent?.username;
        },
        classes(item) {
            if (isOverdue(item)) return '!text-red-600';
        },
        resizable: true,
    },
    {
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
            if (item.company) {
                link = `/lists/companies/${item.company.id}`;
            } else if (item.deal) {
                link = `/deals/${item.deal.id}`;
            } else if (item.ctr_agent) {
                link = `/lists/contacts/${item.ctr_agent.id}`;
            }
            return link;
        },
        field(item) {
            let value = '';
            if (item.company) {
                value = item.company.name;
            } else if (item.deal) {
                value = item.deal.label;
            }
            else if (item.ctr_agent) {
                value = item.ctr_agent.username;
            }
            return value;
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
    emits('fetchTasks');
});
</script>

<style>
</style>
