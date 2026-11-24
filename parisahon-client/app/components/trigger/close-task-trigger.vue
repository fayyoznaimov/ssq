<script setup lang="ts">
import type BaseTextarea from '~/components/form/BaseTextarea.vue';
import type { TaskType } from '~/types/deal';
import { type CloseTasksTrigger,type Trigger } from '~/types/stage';

const props = defineProps<{
  trigger: Trigger & CloseTasksTrigger;
}>();

const taskTypeService = useService('task-types', {auth: true});
const { isLoading: typesLoading, run: runTaskTypes, data: taskTypes } = useAsync<TaskType[]>([]);

const endTimes = ref([
    {
        value: 'all',
        label: 'Все',
    },
    {
        value: 'overdue',
        label: 'Просроченные',
    },
    {
        value: 'today',
        label: 'На сегодня',
    },
    {
        value: 'tomorrow',
        label: 'На завтра',
    },
]);

const saved = props.trigger.close_tasks_data;
const endTime = ref(saved.with_task_end_times?.length
    ? endTimes.value.filter((t) => saved.with_task_end_times.includes(t.value))
    : [endTimes.value[0]]);
const taskType = ref<TaskType>();

// «Любой тип» (0): the trigger closes the open tasks of every type
const ANY_TYPE = { id: 0, name: 'Любой тип' } as TaskType;
const typeItems = computed(() => [ANY_TYPE, ...taskTypes.value]);

watch([endTime, taskType], () => {
    props.trigger.close_tasks_data.with_task_end_times = endTime.value.map((t) => t.value);
    if (taskType.value) props.trigger.close_tasks_data.type_id = taskType.value.id;
}, { immediate: true });

watchEffect(() => {
    if (!taskType.value && taskTypes.value.length) {
        taskType.value = taskTypes.value.find((t) => t.id === saved.type_id) ?? ANY_TYPE;
    }
});

onMounted(() => {
    runTaskTypes(taskTypeService.find().exec());
});
</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox 
            placeholder="Тип задачи" 
            name="type" 
            v-model="taskType"
            :items="typeItems" 
            :loading="typesLoading" 
            :properties="{ value: 'id', label: 'name' }" 
        />
        <BaseListbox 
            v-model="endTime"
            :items="endTimes"
            :properties="{value: 'value', label: 'label'}"
            placeholder="Со сроком выполнения"
            name="endTime"
            :multiple="true"
            :multipleLabel="(value, prop) => {
                if (!value.length) return;
                else return `${value.map(v => v[prop]).join(', ')}`;
            }"
        />
        <BaseTextarea placeholder="Результат закрытия (попадёт в задачу)" rows="2" name="label" v-model="trigger.close_tasks_data.result" />
    </section>
</template>