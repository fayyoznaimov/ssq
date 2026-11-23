<template>
    <!-- date, assignee and type; on a phone they wrap instead of squeezing to a few px -->
    <div class="flex flex-wrap lg:flex-nowrap items-center gap-2 w-full [&>*]:min-w-[9rem] [&>*]:flex-1 lg:[&>*]:min-w-[auto] lg:[&>*]:flex-initial">
        <DatePicker v-model="date" text-input vertical :preset-dates="presetDates" @internal-model-change="handleInternalChange" :dark="isDarkMode">
            <template #dp-input="{ onInput, value, onBlur, onPaste }">
                <BaseInput :size="size" :value="value" @input="onInput" @blur="onBlur" @paste="onPaste" />
            </template>
            <template #right-sidebar>
                <div class="w-96 h-full">
                    <FullCalendar :options="calendarOpts" />
                </div>
            </template>
        </DatePicker>
        <input type="hidden" name="start" v-model="internalEvent.startStr">
        <input type="hidden" name="end" v-model="internalEvent.endStr">
        <!-- the forms read "allDay" (TaskModal, the deal, company and contact pages); "all_day" was never saved -->
        <input v-if="internalEvent.allDay" type="hidden" name="allDay" value="true">
        <BaseAutocomplete
            name="assignee"
            :size="size"
            v-model="assignee"
            :items="groupedUsers"
            :display-value="displayUserGroup"
            :filter-items="nameFilter"
            :item-classes="{
                wrapper: (data: UserGroup) => data.target === 'group' ? 'bg-primary-500/20 dark:bg-primary-400 text-white' : '',
                active: (data: UserGroup) => data.target === 'group' ? 'bg-primary-500/30' : 'bg-muted-100 dark:bg-muted-700'
            }"
            :properties="{
                value: 'tempId',
                label: (data: UserGroup) => data.target === 'group' ? data.name : data.username,
            }"
            dropdown
        />
        <BaseListbox
            name="type"
            :size="size"
            v-if="task"
            v-model="task.type"
            :items="taskTypes"
            :loading="typesLoading"
            :properties="{ value: 'id', label: 'name' }"
            :onCreate="(v: string) => ({name: v})"
        />
    </div>
</template>
<script setup lang="ts">
import type { EventApi } from '@fullcalendar/core';
import ruLocale from '@fullcalendar/core/locales/ru';
import InteractionPlugin from '@fullcalendar/interaction';
import TimeGridPlugin from '@fullcalendar/timegrid';
import FullCalendar from '@fullcalendar/vue3';
import DatePicker from '@vuepic/vue-datepicker';
import moment from 'moment';

import type { BaseAutocomplete } from '#build/components';
import { useAsync } from '~/composables/useAsync';
import { useService } from '~/composables/useService';
import type { Task, TaskType } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';
import { type Group, type User, UserRole } from '~/types/user';

enum Target {
    Agent = 'agent',
    Group = 'group',
    None = 'none'
}

type GroupedUser = User & {target: Target.Agent, tempId: string};
type GroupedGroup = Group & {target: Target.Group, tempId: string};
type UserGroup = GroupedUser | GroupedGroup;

const props = withDefaults(defineProps<{
    size?: 'sm' | 'md' | 'lg',
    initialDate?: string;
    agent: User;
    group?: Group | null;
}>(), {
    size: 'md',
    initialDate: new Date().toISOString(),
});

const isDarkMode = useDarkMode();
const task = defineModel<Partial<Task>>({ default: {} });

/**
 * The task as the event of the small calendar. A day without a time ("2026-11-23", a click on a day
 * in the calendar) or an all-day task is an all-day event: as a timed one it became 05:00 (a date is
 * read as UTC midnight). The calendar ends an all-day event on the next day; the API keeps it until
 * 23:59 of its last day.
 */
function initialEvent(): Partial<EventApi> {
    const start = task.value.start_time || task.value.start || new Date().toISOString();
    const end = task.value.end_time || task.value.end || start;
    const title = task.value.type?.name || '';
    const plainDate = /^\d{4}-\d{2}-\d{2}$/.test(String(start));
    if (!task.value.allDay && !plainDate) {
        return { start: new Date(start), end: new Date(end), startStr: start, endStr: end, allDay: false, title };
    }
    const first = moment(start).startOf('day');
    const endAt = moment(end);
    const midnight = endAt.hours() === 0 && endAt.minutes() === 0 && endAt.seconds() === 0;
    const last = midnight && endAt.isAfter(first) ? endAt.clone().subtract(1, 'ms') : endAt;
    const startStr = first.format('YYYY-MM-DD');
    const endStr = moment.max(last, first).clone().add(1, 'day').format('YYYY-MM-DD');
    return { start: startStr as any, end: endStr as any, startStr, endStr, allDay: true, title };
}

const internalEvent = ref<Partial<EventApi>>(initialEvent());

const taskTypeService = useService('task-types', {auth: true});
const userService = useService('users', {auth: true});
const staffService = useService('users/staff', {auth: true});

const { run: runUsers, data: users } = useAsync<{data: User[], count: number}>({ data: [], count: 0 });
const { isLoading: typesLoading, run: runTaskTypes, data: taskTypes } = useAsync<TaskType[]>([]);

let data: UserGroup = {target: Target.Agent, tempId: 'agent-' + props.agent.id, ...props.agent };
if (props.group) {
    data = { target: Target.Group, tempId: 'group-' + props.group.id, ...props.group };
} 

const assignee = ref<UserGroup>(data);

const date = ref(props.initialDate);
const internalDate = ref(props.initialDate);
const toast = useToast('GlobalToast');
let fakeId = -1;

function handleInternalChange(date?: Date) {
    internalDate.value = date?.toISOString() || new Date().toISOString();
}

const presetDates = ref([
    {label: 'Через 15 минут', value: moment().add(15, 'minutes')},
    {label: 'Через 30 минут', value: moment().add(30, 'minutes')},
    {label: 'Через час', value: moment().add(1, 'hour')},
    {label: 'Сегодня', value: moment()},
    {label: 'Завтра', value: moment().add(1, 'day')},
    {label: 'До конца недели', value: moment().endOf('week')},
    {label: 'Через неделю', value: moment().add(1, 'week').startOf('week')},
    {label: 'Через месяц', value: moment().add(1, 'month').startOf('month')},
    {label: 'Через год', value: moment().add(1, 'year')},
]);

const calendarOpts = ref({
    plugins: [
        InteractionPlugin,
        TimeGridPlugin,
    ],
    locale: ruLocale,
    headerToolbar: false,
    dayHeaders: false,
    initialView: 'timeGrid',
    selectable: true,
    selectMirror: true,
    editable: true,
    selectOverlap: false,
    dragScroll: true,
    slotDuration: '00:30',
    forceEventDuration: true,
    contentHeight: '100%',
    height: '100%',
    initialEvents: [internalEvent.value],
    now: () => internalDate.value,
    slotLabelFormat: {
        hour: '2-digit',
        minute: '2-digit',
        omitZeroMinute: false,
        meridiem: 'short'
    },
    eventsSet: (events: any) => {
        internalEvent.value = events[0];
    },
    select: (info: any) => {
        const api = info.view.calendar;
        api.unselect();

        const existing = api.getEventById(internalEvent.value.id);
        if (existing) existing.remove();
        internalEvent.value = api.addEvent({
            id: --fakeId,
            title: task.value.type?.name,
            start: info.startStr,
            end: info.endStr,
            allDay: info.allDay,
            extendedProps: {
                assignee: assignee.value,
                type: task.value.type,
            }
        });
    },
    eventColor: 'rgb(4, 87, 77)',
    eventBackgroundColor: 'rgb(4, 87, 77)',
    eventBorderColor: 'rgb(4, 87, 77)',
    eventTextColor: 'white'
});

// each group, then its people (by name); staff without a group at the end
const groupedUsers = computed(() => {
    const groups = new Map<number, UserGroup[]>();
    const loose: UserGroup[] = [];
    for (const user of users.value.data) {
        if (user.role === UserRole.CtrAgent) continue;
        const person: UserGroup = {...user, tempId: `agent-${user.id}`, target: Target.Agent};
        if (!user.group) {
            loose.push(person);
            continue;
        }
        if (!groups.has(user.group.id)) groups.set(user.group.id, [{...user.group, tempId: `group-${user.group.id}`, target: Target.Group}]);
        groups.get(user.group.id)!.push(person);
    }

    return [...[...groups.values()].flat(), ...loose];
});

watch(() => [task.value.type], async () => {
    if (!task.value.type?.id) {
        const existing = taskTypes.value.some((t) => t.name === task.value.type?.name);
        if (existing) return;
        if (!task.value.type?.name) return;
        const result = await promiseResult(taskTypeService.create<TaskType>({ name: task.value.type.name }).exec());
        if (!result.ok) return toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        taskTypes.value.push(result.value);
        task.value.type.id = result.value.id;
    }
});

// TODO: search when backend implements it better
const onUserInput = debounce((e: Event) => {
    const target = (e.target as HTMLInputElement);
    runUsers(userService.find({ username: target.value }).exec());
}, 500);

function nameFilter(query?: string, items?: UserGroup[]) {
    if (!query || !items) return items;
    const lowercased = query.toLowerCase();
    const filtered: UserGroup[] = [];
    for (let item of items) {
        let shouldAdd;
        if (item.target === 'group') shouldAdd = item.name.toLowerCase().includes(lowercased);
        else shouldAdd = item.username.toLowerCase().includes(lowercased);
        if (shouldAdd) filtered.push(item);
    }

    return filtered;
}

function displayUserGroup(u: UserGroup) {
    if (u.target === 'group') return u.name;
    if (u.target === 'agent') return u.username;
}
watch(taskTypes, () => {
    if (!task.value.type && taskTypes.value.length) {
        task.value.type = taskTypes.value[0];
        internalEvent.value.setProp?.('title', task.value.type?.name ?? '');
    }
});

/** The staff accounts for the assignee (GET /users/staff); an API without it: all users minus the contacts. */
async function staffUsers(): Promise<{data: User[], count: number}> {
    try {
        return await staffService.find<PaginatedResponse<User>>().exec();
    } catch (e) {
        const all = await userService.find<PaginatedResponse<User>>({limit: 1000}).exec();
        const data = (all.data ?? []).filter((u) => u.role !== UserRole.CtrAgent);
        return {data, count: data.length};
    }
}

onMounted(() => {
    runTaskTypes(taskTypeService.find().exec());
    runUsers(staffUsers());
});

</script>