<script setup lang="ts">
import moment from 'moment';
import Draggable from 'vuedraggable';
import { countOf, formatDateTime, formatDay } from '~/utils/format';

import type { Task } from '~/types/deal';

import { confirmTaskPlan, isTaskPlanCancelled } from './taskPlan';
import { isTaskOverdue, overdueText, tasksCount, taskWhen } from './taskText';

type TaskColumnType = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'nextWeek' | 'future';

const props = withDefaults(defineProps<{
    tasks: Task[];
    title: string;
    divider?: string | string[];
    color?: string | string[];
    type: TaskColumnType;
}>(), {
    divider: 'border-muted-300 dark:border-muted-600',
    color: 'text-muted-900 dark:text-white'
});

// after a drop the board reloads: the moved task gets its new dates, a failed move goes back
const emit = defineEmits(['moved']);

const taskService = useService('tasks', {auth: true});
const toast = useToast('GlobalToast');
const taskResultModal = useModal('TaskResultModal');
const taskModal = useModal('TaskModal');

const dragOptions = {
    animation: 200,
    ghostClass: 'ghost',
};

/**
 * Only the times change. The deal goes first: an automatic task names its deal and the deal's
 * company, and the company sent first used to unlink the deal (the API now keeps the links anyway).
 */
function createUpdatePayload(task: Partial<Task>) {
    const payload: Record<string, any> = {
        start_time: task.start_time,
        end_time: task.end_time,
        allDay: !!task.allDay,
    };
    if (task.label) payload.label = task.label;
    if (task.type?.id) payload.type_id = task.type.id;
    if (task.agent) payload.assign_to = { target: 'agent', id: task.agent.id };
    else if (task.group) payload.assign_to = { target: 'group', id: task.group.id };
    if (task.deal) payload.link_to = { target: 'deal', id: task.deal.id };
    else if (task.ctr_agent) payload.link_to = { target: 'ctr_agent', id: task.ctr_agent.id };
    else if (task.company) payload.link_to = { target: 'company', id: task.company.id };
    return payload;
}

/** The first day of a column the task is dropped into. */
function targetDay(type: TaskColumnType) {
    const today = moment().startOf('day');
    switch (type) {
        case 'tomorrow': return today.clone().add(1, 'day');
        case 'thisWeek': {
            // after tomorrow, still this week (Sunday at the latest)
            const day = today.clone().add(2, 'day');
            const sunday = today.clone().endOf('isoWeek').startOf('day');
            return day.isAfter(sunday) ? sunday : day;
        }
        case 'nextWeek': return today.clone().add(1, 'week').startOf('isoWeek');
        case 'future': return today.clone().add(2, 'week').startOf('isoWeek');
        default: return today;
    }
}

async function onChange(event: Record<string, any>) {
    if (!event.added) return;
    const task = event.added.element as Task;
    const startAt = moment(task.start);
    const endAt = moment(task.end);
    const duration = Math.max(0, endAt.diff(startAt));
    const day = targetDay(props.type);

    // the same time of day on the new day, the same length; on "today" not in the past
    let newStart = day.clone().hours(startAt.hours()).minutes(startAt.minutes()).seconds(0).milliseconds(0);
    if (task.allDay) newStart = day.clone();
    else if (props.type === 'today' && newStart.isBefore(moment())) newStart = moment().seconds(0).milliseconds(0);
    const newEnd = task.allDay ? day.clone().endOf('day') : newStart.clone().add(duration, 'ms');

    const payload = createUpdatePayload({
        ...task,
        start_time: newStart.toISOString(),
        end_time: newEnd.toISOString(),
    });

    // a time in the past or next to another task of the deal: the API asks first (taskPlan.ts)
    const result = await promiseResult(confirmTaskPlan((flags) => taskService.patch(task.id, {...payload, ...flags}).exec()));
    if (!result.ok && !isTaskPlanCancelled(result.error)) toast.show({message: result.error.message, type: 'error', timeout: 5000});
    emit('moved');
}

function client(task: Task) {
    return task.deal?.company?.name || task.company?.name || task.ctr_agent?.company?.name || '';
}

/** «Встреча · завтра 10:00 · admin» */
function meta(task: Task) {
    const who = task.agent?.username || (task.group ? `группа ${task.group.name}` : '');
    return [task.type?.name ?? 'Задача', taskWhen(task.start, task.allDay), who].filter(Boolean).join(' · ');
}

</script>
<template>
    <div class="flex flex-col">
        <div class="flex flex-col items-center justify-center pt-2 pb-1.5">
            <h2 class="uppercase text-xs font-semibold text-center">{{ title }}</h2>
            <span class="text-sm text-muted-700 dark:text-muted-400">{{ tasksCount(tasks.length) }}</span>
        </div>
        <hr class="border-2" :class="divider">
        <!-- nothing is dropped into "overdue": a moved task gets a new date -->
        <Draggable 
            v-bind="dragOptions" 
            item-key="id" 
            :list="props.tasks" 
            tag="ul" 
            class="mt-2 flex flex-col gap-2"
            :class="tasks.length ? 'min-h-[3rem]' : 'min-h-[3rem] rounded-md border border-dashed border-muted-300 dark:border-muted-700'"
            :group="{name: 'tasks', pull: true, put: type !== 'overdue'}"
            @change="onChange"
        >
            <template #item="{ element: task }: {element: Task, index: number}">
                <li :key="task.id" class="relative">
                    <!-- the text first, then the client and the deal, then type · time · who; ✓ closes it -->
                    <div
                        role="button"
                        tabindex="0"
                        class="bg-muted-200 p-2 pe-9 dark:bg-muted-800 rounded-md w-full text-left cursor-move"
                        @click="taskModal.open(task)"
                        @keydown.enter="taskModal.open(task)"
                    >
                        <p class="text-[13px] font-medium text-muted-900 dark:text-white break-words line-clamp-2" :title="task.label">{{ task.label }}</p>
                        <p class="text-[13px] text-muted-600 dark:text-muted-300 truncate" v-if="task.ctr_agent"><span>{{ task.ctr_agent.username }}</span><span v-if="task.ctr_agent.company">, {{ task.ctr_agent.company.name }}</span></p>
                        <p class="text-[13px] text-muted-600 dark:text-muted-300 truncate" v-else-if="client(task)">{{ client(task) }}</p>
                        <NuxtLink v-if="task.deal" :to="'/deals/' + task.deal.id" class="block text-[13px] text-blue-600 dark:text-blue-400 underline truncate" @click.stop>{{ task.deal.label }}</NuxtLink>
                        <p class="text-xs mt-1 text-muted-500 dark:text-muted-400">
                            <span :class="color">{{ meta(task) }}</span>
                        </p>
                        <span
                            v-if="isTaskOverdue(task)"
                            class="inline-block mt-1 rounded px-1.5 py-0.5 text-xs bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                        >{{ overdueText(task) }}</span>
                    </div>
                    <BaseButtonIcon
                        size="sm"
                        rounded="full"
                        class="!absolute top-1.5 end-1.5"
                        title="Выполнить"
                        @click.stop="taskResultModal.open(task)"
                    >
                        <Icon name="ph:check" class="size-4 text-green-600" />
                    </BaseButtonIcon>
                </li>
            </template>
        </Draggable>
    </div>
</template>
