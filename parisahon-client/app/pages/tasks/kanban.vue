<script setup lang="ts">
import moment from 'moment';

import TaskColumn from '~/components/task/TaskColumn.vue';
import TaskModal from '~/components/task/TaskModal.vue';
import TaskResultModal from '~/components/task/TaskResultModal.vue';
import type { Task } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';
const props = withDefaults(defineProps<{
    tasks: PaginatedResponse<Task>;
    tasksLoading: boolean;
}>(), {});

const emits = defineEmits(['fetchTasks']);

type GroupedTasks = {
  overdue: Task[];
  today: Task[];
  tomorrow: Task[];
  thisWeek: Task[];
  nextWeek: Task[];
  future: Task[];
}

const overdue = ref<Task[]>([]);
const today = ref<Task[]>([]);
const tomorrow = ref<Task[]>([]);
const thisWeek = ref<Task[]>([]);
const nextWeek = ref<Task[]>([]);
const future = ref<Task[]>([]);


watch(() => props.tasks, () => {
    const grouped: GroupedTasks = {
        overdue: [],
        today: [],
        tomorrow: [],
        thisWeek: [],
        nextWeek: [],
        future: [],
    };

    for (const task of props.tasks.data) {
        const endAt = moment(task.end).endOf('day');
        const startAt = moment(task.start).endOf('day');
        const now = moment();
        const next = moment().add(1, 'week').startOf('week');
        const isOverdue = endAt.isBefore(moment()) && !task.closed_at;
        const isToday = startAt.isSame(now, 'day');
        const isTomorrow = startAt.isSame(now.add(1, 'day'), 'day');
        const isThisWeek = startAt.isSame(now, 'week');
        const isNextWeek = startAt.isSame(next, 'week');
        const isFuture = startAt.isSame(moment().add(1, 'month').startOf('month').endOf('day'));
        if (isOverdue) grouped.overdue.push(task);
        else if (isToday) grouped.today.push(task);
        else if (isTomorrow) grouped.tomorrow.push(task);
        else if (isThisWeek) grouped.thisWeek.push(task);
        if (isNextWeek) grouped.nextWeek.push(task);
        if (isFuture) grouped.future.push(task);
    }

    overdue.value = grouped.overdue;
    today.value = grouped.today;
    tomorrow.value = grouped.tomorrow;
    thisWeek.value = grouped.thisWeek;
    nextWeek.value = grouped.nextWeek;
    future.value = grouped.future;
});

onMounted(() => {
    emits('fetchTasks');
});

</script>
<template>
    <div>
        <TaskResultModal id="TaskResultModal" @saved="emits('fetchTasks')" />
        <TaskModal @save="emits('fetchTasks')" id="TaskModal" />
        <ul class="grid grid-cols-4 gap-4">
            <li>
                <TaskColumn 
                    :tasks="overdue" 
                    title="Просроченные задачи" 
                    divider="border-red-400" 
                    color="text-red-400" 
                    type="overdue"
                />
            </li>
            <li>
                <TaskColumn 
                    :tasks="today" 
                    title="Задачи на сегодня" 
                    divider="border-green-600 dark:border-green-400" 
                    color="text-green-600 dark:text-green-400"
                    type="today"
                />
            </li>
            <li>
                <TaskColumn :tasks="tomorrow" title="Задачи на завтра" type="tomorrow" />
            </li>
            <li>
                <ul class="flex flex-col gap-6">
                    <li>
                        <TaskColumn :tasks="thisWeek" title="Задачи на эту неделю" type="thisWeek" />
                    </li>
                    <li>
                        <TaskColumn :tasks="nextWeek" title="Задачи на следующую неделю" type="nextWeek" />
                    </li>
                    <li>
                        <TaskColumn :tasks="future" title="Задачи на будущее" type="future" />
                    </li>
                </ul>
            </li>
        </ul>
    </div>
</template>