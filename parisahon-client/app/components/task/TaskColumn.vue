<script setup lang="ts">
import moment from 'moment';
import Draggable from 'vuedraggable';

import type { Task } from '~/types/deal';

const props = withDefaults(defineProps<{
    tasks: Task[];
    title: string;
    divider?: string | string[];
    color?: string | string[];
    type: 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'nextWeek' | 'future';
}>(), {
    divider: 'border-muted-300 dark:border-muted-600',
    color: 'text-muted-900 dark:text-white'
});

const taskService = useService('tasks', {auth: true});
const toast = useToast('GlobalToast');
const taskResultModal = useModal('TaskResultModal');

const dragOptions = {
    animation: 200,
    ghostClass: 'ghost',
};

function createUpdatePayload(task: Partial<Task>) {
    const assign = { target: '', id: -1 };
    const link = {target: '', id: -1};
    if (task.agent) {
        assign.target = 'agent';
        assign.id = task.agent.id;
    } else if (task.group) {
        assign.target = 'group';
        assign.id = task.group.id;
    }

    if (task.company) {
        link.target = 'company';
        link.id = task.company.id;
    } else if (task.deal) {
        link.target = 'deal';
        link.id = task.deal.id;
    } else if (task.ctr_agent) {
        link.target = 'ctr_agent';
        link.id = task.ctr_agent.id;
    }

    return {
        label: task.label,
        type_id: task.type?.id,
        assign_to: assign,
        link_to: link,
        start_time: task.start_time,
        end_time: task.end_time,
        allDay: task.allDay
    };
}

async function onChange(event: Record<string, any>) {
    if (!event.added) return;
    const task = event.added.element as Task;
    const endAt = moment(task.end);
    const startAt = moment(task.start);
    let now = moment().local();
    if (props.type === 'tomorrow') {
        now = moment().add(1, 'day');
    } else if (props.type === 'thisWeek') {
        now = moment().endOf('week');
    } else if (props.type === 'nextWeek') {
        now = moment().add(1, 'week').startOf('week');
    } else if (props.type === 'future') {
        now = moment().add(1, 'month').startOf('month');
    }

    endAt.year(now.year());
    endAt.month(now.month());
    endAt.date(now.date());

    startAt.year(now.year());
    startAt.month(now.month());
    startAt.date(now.date());

    const payload = createUpdatePayload({
        ...task,
        start_time: startAt.toISOString(),
        end_time: endAt.toISOString(),
    });

    const result = await promiseResult(taskService.patch(task.id, payload).exec());
    if (!result.ok) toast.show({message: result.error.message, type: 'error', timeout: 3000});
}

</script>
<template>
    <div class="flex flex-col">
        <div class="flex flex-col items-center justify-center pt-2 pb-1.5">
            <h2 class="uppercase text-xs font-semibold">{{ title }}</h2>
            <span class="text-sm text-muted-700 dark:text-muted-400">{{ tasks.length }} задачи</span>
        </div>
        <hr class="border-2" :class="divider">
        <Draggable 
            v-bind="dragOptions" 
            item-key="id" 
            :list="props.tasks" 
            tag="ul" 
            class="mt-2 flex flex-col gap-2 min-h-[8rem]"
            :group="{name: 'tasks', pull: true}"
            @change="onChange"
        >
            <template #item="{ element: task }: {element: Task, index: number}">
                <li :key="task.id">
                    <button class="bg-muted-200 p-1.5 dark:bg-muted-800 rounded-md w-full text-left cursor-move" @click="taskResultModal.open(task)">
                        <div>
                            <p class="text-[13px]" v-if="task.ctr_agent"><span>{{ task.ctr_agent.username }}</span><span v-if="task.ctr_agent.company">, {{ task.ctr_agent.company.name }}</span></p>
                            <NuxtLink v-if="task.deal" :href="'/deals/' + task.deal.id" class="text-[15px] text-blue-600 cursor-pointer">{{ task.deal.label }}</NuxtLink>
                        </div>
                        <div class="text-[13px]">
                            <p class="text-muted-700 dark:text-muted-400"><span :class="color">
                                {{ new Date(task.start).toLocaleString('ru') }}
                            </span><span v-if="task.agent">, для {{ task.agent.username }}</span></p>
                            <span class="font-semibold text-muted-900 dark:text-white">{{ task.type.name }}</span>
                        </div>
                    </button>
                </li>
            </template>
        </Draggable>
    </div>
</template>