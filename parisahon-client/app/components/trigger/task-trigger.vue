<script setup lang="ts">
import type BaseTextarea from '~/components/form/BaseTextarea.vue';
import type { TaskType } from '~/types/deal';
import { type TaskTrigger,type Trigger } from '~/types/stage';
import type { User } from '~/types/user';

type Responsible = {
  label: string;
  id: string | number;
}

const props = defineProps<{
  employees: User[];
  trigger: Trigger & TaskTrigger;
}>();

const taskTypeService = useService('task-types', {auth: true});
const { isLoading: typesLoading, run: runTaskTypes, data: taskTypes } = useAsync<TaskType[]>([]);

// The deadline of the task. The API counts it in working time (CONTROL_WORK_HOURS): «Конец дня» is
// the end of today's working day, «через N дней» the end of the working day N days later.
type EndTime = { key: string; label: string; endTimeInMinutes: number; allDay: boolean; deadline?: 'end_of_working_day' };
const endTimes = ref<EndTime[]>([
    // the API gives such a task 30 minutes (TRIGGER_TASK_MIN_MINUTES): it is never overdue as soon as it appears
    { key: 'now', endTimeInMinutes: 0, label: 'Сразу (срок — через 30 минут)', allDay: false },
    { key: 'eod', endTimeInMinutes: 0, label: 'Конец рабочего дня', allDay: false, deadline: 'end_of_working_day' },
    { key: '1440', endTimeInMinutes: 1440, label: 'Через день (до конца рабочего дня)', allDay: false },
    { key: '4320', endTimeInMinutes: 4320, label: 'Через 3 дня (до конца рабочего дня)', allDay: false },
    { key: '10080', endTimeInMinutes: 10080, label: 'В течение недели', allDay: false },
]);

// a saved trigger opens with its own values; a new one (just added, never «Готово») is due by the end
// of the working day: «в момент события» makes the task overdue as soon as it appears
const saved = props.trigger.create_task_data;
function savedEndTime(): EndTime {
    const list = endTimes.value;
    const fresh = (props.trigger.id ?? 0) <= 0 && !props.trigger.status;
    if (fresh && !saved.deadline && !saved.end_time_in_minutes) return list[1];
    if (saved.deadline === 'end_of_working_day') return list[1];
    // «Конец дня» of before: 1440 minutes and all day
    if (saved.end_time_in_minutes === 1440 && saved.all_day) return list[1];
    const found = list.find((t) => !t.deadline && t.endTimeInMinutes === saved.end_time_in_minutes);
    if (found) return found;
    const minutes = Number(saved.end_time_in_minutes ?? 0);
    const other: EndTime = { key: String(minutes), endTimeInMinutes: minutes, label: `Через ${minutes} мин`, allDay: !!saved.all_day };
    list.push(other);
    return other;
}
const endTime = ref<EndTime>(savedEndTime());
const taskType = ref<TaskType>();
const responsible = ref<Responsible>(
    saved.responsible?.exact_user_id
        ? { label: props.employees.find((e) => e.id === saved.responsible.exact_user_id)?.username ?? 'Сотрудник', id: saved.responsible.exact_user_id }
        // 'created': how an older version of this form saved «Создатель сделки»
        : saved.responsible?.user === 'creator' || saved.responsible?.user === 'created'
            ? { label: 'Создатель сделки', id: 'creator' }
            : { label: 'Текущий ответственный', id: 'currently_assigned' },
);

const responsibles = computed(() => {
    const data: Responsible[] = [
        { label: 'Текущий ответственный', id: 'currently_assigned' },
        { label: 'Создатель сделки', id: 'creator' },
    ];

    for (const employee of props.employees) {
        data.push({
            label: employee.username,
            id: employee.id,
        });
    }
    return data;
});

// written back at once too: a trigger saved before the task types load keeps the shown deadline
watch([endTime, taskType, responsible], () => {
    props.trigger.create_task_data.end_time_in_minutes = endTime.value.endTimeInMinutes;
    props.trigger.create_task_data.all_day = endTime.value.allDay;
    props.trigger.create_task_data.deadline = endTime.value.deadline;
    if (typeof responsible.value.id === 'number') {
        props.trigger.create_task_data.responsible = { exact_user_id: responsible.value.id };
    } else {
        props.trigger.create_task_data.responsible = { user: responsible.value.id };
    }
    if (taskType.value) props.trigger.create_task_data.type_id = taskType.value.id;
}, { immediate: true });

watchEffect(() => {
    if (!taskType.value && taskTypes.value.length) {
        taskType.value = taskTypes.value.find((t) => t.id === saved.type_id) ?? taskTypes.value[0];
    }
});

onMounted(() => {
    runTaskTypes(taskTypeService.find().exec());
});

</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox 
            v-model="endTime"
            :items="endTimes"
            :properties="{value: 'key', label: 'label'}"
            placeholder="Со сроком выполнения"
            name="endTime"
        />
        <BaseListbox 
            v-model="responsible"
            :items="responsibles"
            :properties="{value: 'id', label: 'label'}"
            placeholder="Ответственный"
            name="responsible"
        />
        <BaseListbox 
            placeholder="Тип задачи" 
            name="type" 
            v-model="taskType"
            :items="taskTypes" 
            :loading="typesLoading" 
            :properties="{ value: 'id', label: 'name' }" 
        />
        <BaseTextarea placeholder="Комментарий" rows="2" name="label" v-model="trigger.create_task_data.label" />
    </section>
</template>