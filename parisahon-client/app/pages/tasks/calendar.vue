<template>
    <div class="min-h-[calc(100vh-4rem)] w-full">
        <BasePlaceload class="h-2 w-full" v-show="tasksLoading" />
        <FullCalendar :options="calendarOptions" />
        <TaskModal @save="emits('fetchTasks')" id="TaskModal" />
        <TaskResultModal id="TaskResultModal" @saved="emits('fetchTasks')" />
    </div>
</template>
<script lang="ts" setup>
import type { EventApi } from '@fullcalendar/core';
import ruLocale from '@fullcalendar/core/locales/ru';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import timeGridPlugin from '@fullcalendar/timegrid';
import FullCalendar from '@fullcalendar/vue3';
import moment from 'moment';

import TaskModal from '~/components/task/TaskModal.vue';
import TaskResultModal from '~/components/task/TaskResultModal.vue';
import { useService } from '~/composables/useService';
import type { Deal, TaskFilters, TaskType } from '~/types/deal';
import type { Task } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';
import type { Company, Group, User } from '~/types/user';
import { promiseResult } from '~/utils/result';

definePageMeta({
    layout: 'account',
    verbose: 'Месяц',
    subject: 'Task'
});

useHead({
    title: 'Месяц',
});

const props = withDefaults(defineProps<{
    filters: TaskFilters;
    tasks: PaginatedResponse<Task>;
    tasksLoading: boolean;
}>(), {});

const taskModal = useModal('TaskModal');
const taskResultModal = useModal('TaskResultModal');
const events = ref<Partial<EventApi>[]>([]);
const taskService = useService('tasks', {auth: true});
const toast = useToast('GlobalToast');
const emits = defineEmits(['fetchTasks']);

const eventList = computed(() => {
    return events.value;
});

const calendarOptions = ref({
    locale: ruLocale,
    plugins: [
        dayGridPlugin,
        timeGridPlugin,
        interactionPlugin,
    ],
    headerToolbar: {
        center: 'title',
        left: 'dayGridMonth timeGridWeek timeGridDay',
        right: 'prev,next today',
    },
    buttonText: {
        today: 'Сегодня',
        month: 'Месяц',
        week: 'Неделя',
        day: 'День'
    },
    nowIndicator: true,
    events: eventList,
    slotLabelFormat: {
        hour: '2-digit',
        minute: '2-digit',
        omitZeroMinute: false,
    },
    firstDay: 1,
    initialView: 'timeGridWeek',
    initialEvents: events.value,
    editable: true,
    selectable: true,
    selectMirror: true,
    dayMaxEvents: true,
    weekends: true,
    select: handleDateSelect,
    eventClick: handleEventClick,
    eventsSet: handleEvents,
    eventDrop: handleDrop,
    eventResize: handleResize,
    datesSet: handleDateSet,
    forceEventDuration: true,
    eventColor: 'rgb(4, 87, 77)',
    eventBackgroundColor: 'rgb(4, 87, 77)',
    eventBorderColor: 'rgb(4, 87, 77)',
    eventTextColor: 'white',
    eventClassNames: ({event}) => {
        const endAt = moment(event.endStr);
        const overdue = endAt.isBefore(moment());
        if (overdue && !event.extendedProps.closed_at) return ['fc-event-overdue'];
        const closedAt = moment(event.extendedProps.closed_at);
        if (closedAt.isBefore(moment())) return ['fc-event-on-time'];
    },
    eventContent: ({event}) => {
        const container = document.createElement('div');
        container.classList.add('fc-event-content');
        const top = document.createElement('p');
        const bottom = document.createElement('p');
        let result = '';
        if (event.extendedProps?.deal) {
            result += 'Сделка ' + event.extendedProps.deal.label;
        }
        if (event.extendedProps?.ctr_agent) {
            result += event.extendedProps?.ctr_agent.username;
        }
        if (event.extendedProps?.company) {
            result += event.extendedProps?.company.name;
        }

        if (result) {
            top.innerText = result;
            container.append(top);
        }

        result = '';

        if (event.extendedProps.type?.name) result += event.extendedProps.type.name;
        if (event.extendedProps?.label) result += ': ' + event.extendedProps?.label;

        if (result) {
            bottom.innerText = result;
            container.append(bottom);
        }
        
        return { domNodes: [container] };
    }
});


async function handleDateSet({startStr, endStr}: {startStr: string, endStr: string}) {
    emits('fetchTasks', {
        from_date: moment(startStr).subtract(1, 'day').format('YYYY-MM-DD'),
        till_date: moment(endStr).format('YYYY-MM-DD'),
    });
}

function toEvent(task: Task) {
    return {
        id: String(task.id),
        end: new Date(task.end),
        start: new Date(task.start),
        title: task.label,
        allDay: task.allDay,
        type: task.type,
        group: task.group,
        agent: task.agent,
        label: task.label,
        closed_at: task.closed_at,
        company: task.company,
        deal: task.deal,
        ctr_agent: task.ctr_agent,
    };
}

watch(() => props.tasks, (tasks) => {
    events.value = tasks.data.map(toEvent);
});

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

async function handleDrop(info: any) {
    const task = fromSelectInfo(info.event);
    if (!task.id) return;
    const payload = createUpdatePayload(task);
    const result = await promiseResult(taskService.patch(task.id, payload).exec());
    if (!result.ok) toast.show({message: result.error.message, type: 'error', timeout: 3000});
}

async function handleResize(info: any) {
    const task = fromSelectInfo(info.event);
    if (!task.id) return;
    const payload = createUpdatePayload(task);
    const result = await promiseResult(taskService.patch(task.id, payload).exec());
    if (!result.ok) toast.show({message: result.error.message, type: 'error', timeout: 3000});
}

type SelectInfo = {
    id?: number;
    allDay: boolean;
    end: Date | null;
    endStr: string;
    start: Date | null;
    startStr: string;
    extendedProps?: {
        group: Group | null;
        agent: User | null;
        type?: TaskType,
        ctr_agent: User | null;
        company: Company | null;
        deal: Deal | null;
        label: string;
        created_at: string;
    }
}

function fromSelectInfo(info: SelectInfo): Partial<Task> {
    const task: Partial<Task> = {
        id: info.id || -1,
        label: info.extendedProps?.label || '',
        result: null,
        closed_at: '',
        start_time: info.startStr,
        start: info.startStr,
        end: info.allDay ? info.startStr : info.endStr,
        end_time: info.allDay ? info.startStr : info.endStr,
        created_at: info.extendedProps?.created_at || new Date().toISOString(),
        company: info.extendedProps?.company,
        ctr_agent: info.extendedProps?.ctr_agent,
        agent: info.extendedProps?.agent,
        group: info.extendedProps?.group,
        deal: info.extendedProps?.deal,
        type: info.extendedProps?.type,
        allDay: info.allDay
    };

    return task;
}

function handleDateSelect(selectInfo: SelectInfo) {
    taskModal.open(fromSelectInfo(selectInfo));
}

function handleEventClick(clickInfo: any) {
    taskResultModal.open(fromSelectInfo(clickInfo.event));
}

function handleEvents(events) {
    events.value = events;
}

</script>

<style scoped>
.fc {
    max-width: 100% !important;
    height: 100% !important;
}

.fc-col-header, .fc-timegrid-body {
    width: 100% !important;
    height: 100% !important;
}
.fc-scrollgrid-sync-table {
    width: 100% !important;
    height: 100% !important;
}
.fc-daygrid-body {
    width: 100% !important;
    height: 100% !important;
}
.fc-daygrid-body-balanced {
    width: 100% !important;
    height: 100% !important;
}
</style>