<script setup lang="ts">
import Modal from '~/components/common/Modal.vue';
import type { TaskType } from '~/types/deal';
import { promiseResult } from '~/utils/result';
import { russianDecline } from '~/utils/text';

/**
 * Task types (admin). GET /task-types gives each type with `task_count` and `default` (the type the CRM
 * gives its own tasks). A type with tasks is deleted only after the admin agrees to move its tasks to
 * another type (DELETE /task-types/:id?move_to=<id>; without it the API answers 409): a task without a
 * type used to break the task board and the deal history.
 */
type ApiTaskType = TaskType & {task_count?: number, default?: boolean};
type MyTaskType = ApiTaskType & {status?: 'new', original?: string};

const props = defineProps<{ id: string, taskTypes: TaskType[] }>();
const emit = defineEmits(['saved']);
let fakeId = -1;
const toast = useToast('GlobalToast');
const taskTypeService = useService('task-types', { auth: true });
const { runAsync, isLoading: saving } = useAsync();
const taskTypes = ref<MyTaskType[]>([]);
const modal = useModal(props.id);
const scrollRef = ref();
const taskTypeRefs = ref([]);
// removed types with tasks: where their tasks go
let removed: {id: number, moveTo: number | null}[] = [];

// the filter's "Все типы" (id -1) is not a type
function fromProps() {
    taskTypes.value = (props.taskTypes as ApiTaskType[])
        .filter((t) => t.id > 0)
        .map((t) => ({...t, original: t.name}));
    removed = [];
}

function countText(n: number) {
    return `${n} ${russianDecline(n, 'задача', 'задачи', 'задач')}`;
}

async function onSubmit() {
    if (taskTypes.value.some((t) => !t.name?.trim())) {
        return toast.show({message: 'Название типа не может быть пустым', type: 'error', timeout: 3000});
    }
    // one after another: the deletions first (their tasks move to a type that still exists)
    const run = async () => {
        for (const r of removed) {
            await taskTypeService.remove(r.moveTo ? `${r.id}?move_to=${r.moveTo}` : r.id).exec();
        }
        for (const type of taskTypes.value) {
            const name = type.name.trim();
            if (type.id > 0 && name !== type.original) await taskTypeService.patch(type.id, {name}).exec();
            else if (type.id <= 0) await taskTypeService.create({name}).exec();
        }
    };
    const result = await promiseResult(runAsync(run()));
    emit('saved');
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 5000});
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

function onRemove(type: MyTaskType) {
    const rest = taskTypes.value.filter((t) => t.id !== type.id && t.id > 0);
    if (type.id > 0 && !rest.length) {
        return toast.show({message: 'Нельзя удалить последний тип задач', type: 'error', timeout: 3000});
    }
    let moveTo: number | null = null;
    const count = type.task_count ?? 0;
    if (type.id > 0 && count > 0) {
        const target = rest.find((t) => t.default) ?? rest[0];
        const ok = window.confirm(
            `У типа «${type.original ?? type.name}» ${countText(count)}. `
            + `Удалить тип и перенести задачи на тип «${target.name}»?`,
        );
        if (!ok) return;
        moveTo = target.id;
        target.task_count = (target.task_count ?? 0) + count;
    }
    taskTypes.value = taskTypes.value.filter((t) => t.id !== type.id);
    if (type.id > 0) removed.push({id: type.id, moveTo});
}

watch(() => props.taskTypes, fromProps, { immediate: true });

</script>
<template>
    <Modal :id="props.id" size="sm" @shown="fromProps">
        <template #header>
            <div class="flex">
                <h2>Управление типами задач</h2>
            </div>
        </template>
        <form @submit.prevent="onSubmit" id="task-type-form">
            <ul class="flex flex-col space-y-4 max-h-[24rem] p-1 -mx-1 overflow-y-auto no-scrollbar">
                <li v-for="type in taskTypes" class="flex items-center gap-2" :key="type.id">
                    <div class="flex-1 min-w-0">
                        <BaseInput v-model="type.name" ref="taskTypeRefs" />
                        <p v-if="type.id > 0" class="text-xs text-muted-400 mt-1">
                            {{ countText(type.task_count ?? 0) }}<template v-if="type.default"> · по умолчанию</template>
                        </p>
                    </div>
                    <BaseButtonClose
                        class="shrink-0"
                        size="sm"
                        rounded="full"
                        color="danger"
                        title="Удалить тип"
                        @click="onRemove(type)"
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
