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
import listPlugin from '@fullcalendar/list';
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
import { confirmTaskPlan, isTaskPlanCancelled } from '~/components/task/taskPlan';
import { taskSubject } from '~/components/task/taskText';
import { promiseResult } from '~/utils/result';

definePageMeta({
    layout: 'account',
    verbose: 'Календарь',
    subject: 'Task'
});

useHead({
    title: 'Календарь задач',
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

// a phone: seven columns of 40 px were unreadable and the grid stopped at 09:00 — a list of the week
const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;

/** «Встреча: позвонить» and the client (the deal without the word «Сделка»), for the event and its tooltip. */
function eventLines(props: Record<string, any>): [string, string] {
    const what = [props.type?.name ?? 'Задача', props.label].filter(Boolean).join(': ');
    return [what, taskSubject(props)];
}

const calendarOptions = ref({
    locale: ruLocale,
    plugins: [
        dayGridPlugin,
        timeGridPlugin,
        listPlugin,
        interactionPlugin,
    ],
    headerToolbar: phone
        ? { left: 'prev,next', center: 'title', right: 'listWeek,timeGridDay' }
        : { center: 'title', left: 'dayGridMonth timeGridWeek timeGridDay listWeek', right: 'prev,next today' },
    ...(phone ? { footerToolbar: { center: 'today' }, height: 'auto' } : {}),
    buttonText: {
        today: 'Сегодня',
        month: 'Месяц',
        week: 'Неделя',
        day: 'День',
        list: 'Список',
    },
    scrollTime: '08:00:00',
    noEventsText: 'Задач нет',
    nowIndicator: true,
    events: eventList,
    slotLabelFormat: {
        hour: '2-digit',
        minute: '2-digit',
        omitZeroMinute: false,
    },
    firstDay: 1,
    initialView: phone ? 'listWeek' : 'timeGridWeek',
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
    // one line each, cut with «…» inside the event (it ran over the next slots); the whole text on hover
    eventContent: ({event}) => {
        const [what, subject] = eventLines(event.extendedProps ?? {});
        const container = document.createElement('div');
        container.classList.add('fc-event-content', 'overflow-hidden', 'h-full', 'w-full');
        for (const line of [what, subject]) {
            if (!line) continue;
            const p = document.createElement('p');
            p.className = 'truncate leading-tight';
            p.innerText = line;
            container.append(p);
        }
        return { domNodes: [container] };
    },
    eventDidMount: ({event, el}) => {
        el.title = eventLines(event.extendedProps ?? {}).filter(Boolean).join(' — ');
    },
});


// every task of the visible days, not one page of the list (25)
async function handleDateSet({startStr, endStr}: {startStr: string, endStr: string}) {
    emits('fetchTasks', {
        from_date: moment(startStr).subtract(1, 'day').format('YYYY-MM-DD'),
        till_date: moment(endStr).format('YYYY-MM-DD'),
        all: true,
    });
}

// an all-day task lasts until 23:59 of its last day; the calendar ends such an event on the next day
function toEvent(task: Task) {
    const allDay = !!task.allDay;
    return {
        id: String(task.id),
        end: allDay ? moment(task.end).add(1, 'day').format('YYYY-MM-DD') : new Date(task.end),
        start: allDay ? moment(task.start).format('YYYY-MM-DD') : new Date(task.start),
        title: task.label,
        allDay,
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

/**
 * A move or a resize changes the times. The deal goes first: an automatic task names its deal and
 * the deal's company, and the company sent first used to unlink the deal (the API keeps links now).
 */
function createUpdatePayload(task: Partial<Task>) {
    const payload: Record<string, any> = {
        start_time: task.start_time,
        end_time: task.end_time || task.start_time,
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

// a move the API refuses goes back on the calendar
async function saveMove(info: any) {
    const task = fromSelectInfo(info.event);
    if (!task.id) return;
    const payload = createUpdatePayload(task);
    // a time in the past or next to another task of the deal: the API asks first (taskPlan.ts)
    const result = await promiseResult(confirmTaskPlan((flags) => taskService.patch(task.id, {...payload, ...flags}).exec()));
    if (!result.ok) {
        info.revert?.();
        if (!isTaskPlanCancelled(result.error)) toast.show({message: result.error.message, type: 'error', timeout: 5000});
    }
}

async function handleDrop(info: any) {
    await saveMove(info);
}

async function handleResize(info: any) {
    await saveMove(info);
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
        // an all-day day keeps its plain date: the API makes it 00:00-23:59 of that day (not 05:00)
        end: info.endStr || info.startStr,
        end_time: info.endStr || info.startStr,
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
/* a phone: the toolbar in one row, a smaller title */
@media (max-width: 639px) {
    .fc :deep(.fc-toolbar-title) {
        font-size: 1rem;
    }
    .fc :deep(.fc-header-toolbar) {
        gap: 0.5rem;
        margin-bottom: 0.75rem;
    }
}
</style>