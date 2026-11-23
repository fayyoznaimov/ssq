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

// the board shows every open task of the filters, not one page of the list (25)
const BOARD_QUERY = { skip: 0, limit: 1000 };

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

/**
 * A column by day: overdue — the deadline passed; otherwise by the start (a task already started
 * and not overdue is today's). Weeks are Monday to Sunday; "на будущее" is after next week.
 * The days are computed once per grouping, nothing is shifted while comparing.
 */
watch(() => props.tasks, () => {
    const grouped: GroupedTasks = {
        overdue: [],
        today: [],
        tomorrow: [],
        thisWeek: [],
        nextWeek: [],
        future: [],
    };

    const now = moment();
    const todayStart = now.clone().startOf('day');
    const tomorrowStart = todayStart.clone().add(1, 'day');
    const nextWeekStart = todayStart.clone().add(1, 'week').startOf('isoWeek');
    const futureStart = nextWeekStart.clone().add(1, 'week');

    for (const task of props.tasks.data) {
        if (task.closed_at) continue;
        if (moment(task.end).isBefore(now)) {
            grouped.overdue.push(task);
            continue;
        }
        const day = moment.max(moment(task.start), now).clone().startOf('day');
        if (day.isSame(todayStart, 'day')) grouped.today.push(task);
        else if (day.isSame(tomorrowStart, 'day')) grouped.tomorrow.push(task);
        else if (day.isBefore(nextWeekStart)) grouped.thisWeek.push(task);
        else if (day.isBefore(futureStart)) grouped.nextWeek.push(task);
        else grouped.future.push(task);
    }

    const byStart = (a: Task, b: Task) => moment(a.start).valueOf() - moment(b.start).valueOf();
    overdue.value = grouped.overdue.sort((a, b) => moment(a.end).valueOf() - moment(b.end).valueOf());
    today.value = grouped.today.sort(byStart);
    tomorrow.value = grouped.tomorrow.sort(byStart);
    thisWeek.value = grouped.thisWeek.sort(byStart);
    nextWeek.value = grouped.nextWeek.sort(byStart);
    future.value = grouped.future.sort(byStart);
}, { immediate: true });

function reload() {
    emits('fetchTasks', BOARD_QUERY);
}

onMounted(reload);

</script>
<template>
    <div>
        <TaskResultModal id="TaskResultModal" @saved="emits('fetchTasks')" />
        <TaskModal @save="emits('fetchTasks')" id="TaskModal" />
        <p v-if="tasks.count > tasks.data.length" class="text-sm text-amber-500 mb-2">
            Показаны {{ tasks.data.length }} задач из {{ tasks.count }}: сузьте фильтры.
        </p>
        <ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <li>
                <TaskColumn 
                    :tasks="overdue" 
                    title="Просроченные задачи" 
                    divider="border-red-400" 
                    color="text-red-400" 
                    type="overdue"
                    @moved="reload"
                />
            </li>
            <li>
                <TaskColumn 
                    :tasks="today" 
                    title="Задачи на сегодня" 
                    divider="border-green-600 dark:border-green-400" 
                    color="text-green-600 dark:text-green-400"
                    type="today"
                    @moved="reload"
                />
            </li>
            <li>
                <TaskColumn :tasks="tomorrow" title="Задачи на завтра" type="tomorrow" @moved="reload" />
            </li>
            <li>
                <ul class="flex flex-col gap-6">
                    <li>
                        <TaskColumn :tasks="thisWeek" title="Задачи на эту неделю" type="thisWeek" @moved="reload" />
                    </li>
                    <li>
                        <TaskColumn :tasks="nextWeek" title="Задачи на следующую неделю" type="nextWeek" @moved="reload" />
                    </li>
                    <li>
                        <TaskColumn :tasks="future" title="Задачи на будущее" type="future" @moved="reload" />
                    </li>
                </ul>
            </li>
        </ul>
    </div>
</template>
