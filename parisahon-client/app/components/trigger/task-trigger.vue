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

const endTimes = ref([
    {
        endTimeInMinutes: 0,
        label: 'В момент события',
        allDay: false,
    },
    {
        endTimeInMinutes: 1440,
        label: 'Конец дня',
        allDay: true,
    },
    {
        endTimeInMinutes: 2880,
        label: 'Через день',
        allDay: false,
    },
    {
        endTimeInMinutes: 5760,
        label: 'Через 3 дня',
        allDay: false,
    },
    {
        endTimeInMinutes: 10080,
        label: 'В течении недели',
        allDay: false,
    }
]);

// a saved trigger opens with its own values
const saved = props.trigger.create_task_data;
const endTime = ref(endTimes.value.find((t) => t.endTimeInMinutes === saved.end_time_in_minutes) ?? endTimes.value[0]);
const taskType = ref<TaskType>();
const responsible = ref<Responsible>(
    saved.responsible?.exact_user_id
        ? { label: props.employees.find((e) => e.id === saved.responsible.exact_user_id)?.username ?? 'Сотрудник', id: saved.responsible.exact_user_id }
        : saved.responsible?.user === 'creator'
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

watch([endTime, taskType, responsible], () => {
    props.trigger.create_task_data.end_time_in_minutes = endTime.value.endTimeInMinutes;
    props.trigger.create_task_data.all_day = endTime.value.allDay;
    if (typeof responsible.value.id === 'number') {
        props.trigger.create_task_data.responsible = { exact_user_id: responsible.value.id };
    } else {
        props.trigger.create_task_data.responsible = { user: responsible.value.id };
    }
    if (taskType.value) props.trigger.create_task_data.type_id = taskType.value.id;
});

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
            :properties="{value: 'endTimeInMinutes', label: 'label'}"
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