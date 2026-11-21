<script setup lang="ts">
import Modal from '~/components/common/Modal.vue';
import type { TaskType } from '~/types/deal';
import { promiseResult } from '~/utils/result';

const props = defineProps<{ id: string, taskTypes: TaskType[] }>();
type MyTaskType = TaskType & {status: 'new' | 'removed'}
let fakeId = -1;
const toast = useToast('GlobalToast');
const taskTypeService = useService('task-types', { auth: true });
const { runAsync, isLoading: saving } = useAsync();
const taskTypes = ref<MyTaskType[]>(props.taskTypes as MyTaskType[]);
const modal = useModal(props.id);
const scrollRef = ref();
const taskTypeRefs = ref([]);
let removed: number[] = [];

async function onSubmit(e: Event) {
    const promises = removed.map((id) => taskTypeService.remove(id).exec());
    for (const type of taskTypes.value) {
        const {id, ...values} = type;
        if (id > 0) promises.push(taskTypeService.patch(id, values).exec());
        else promises.push(taskTypeService.create(values).exec());
    }
    const result = await promiseResult(runAsync(Promise.all(promises)));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    modal.close();
    removed = [];
}

function onNew() {
    taskTypes.value.push({
        id: --fakeId,
        name: '',
        status: 'new',
    });

    setTimeout(() => {
        scrollRef.value.scrollIntoView({ behavior: 'smooth' });
        taskTypeRefs.value[taskTypeRefs.value.length - 1]?.el?.focus();
    }, 0);
}

function onRemove(id: number) {
    taskTypes.value = taskTypes.value.filter((t) => t.id !== id);
    if (id > 0) removed.push(id);
}

watchEffect(() => {
    taskTypes.value = props.taskTypes as MyTaskType[];
});

</script>
<template>
    <Modal :id="props.id" size="sm">
        <template #header>
            <div class="flex">
                <h2>Управление типами задач</h2>
            </div>
        </template>
        <form @submit.prevent="onSubmit" id="task-type-form">
            <ul class="flex flex-col space-y-4 max-h-[24rem] p-1 -mx-1 overflow-y-auto no-scrollbar">
                <li v-for="type in taskTypes" class="flex items-center gap-2" :key="type.id">
                    <BaseInput v-model="type.name" :classes="{wrapper: 'flex-1'}" ref="taskTypeRefs" />
                    <BaseButtonClose
                        class="shrink-0"
                        size="sm"
                        rounded="full"
                        color="danger"
                        @click="onRemove(type.id)"
                    />
                </li>
                <div ref="scrollRef"></div>
            </ul>
            <BaseButton class="mt-4 w-full mr-1" @click="onNew">
                <Icon name="ph:plus" class="mr-2" />
                Добавить новый
            </BaseButton>
        </form>
        <template #footer>
            <div class="flex gap-2">
                <div class="flex-initial">
                    <BaseButton
                        type="submit"
                        form="task-type-form"
                        color="primary"
                        :loading="saving"
                        :disabled="saving"
                    >
                        Сохранить
                    </BaseButton>
                </div>
            </div>
        </template>
    </Modal>
</template>
