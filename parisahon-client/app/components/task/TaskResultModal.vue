<template>
    <Modal
        :id="props.id"
        @shown="onShown"
        size="2xl"
    >
        <template #header>
            <div class="flex">
                <h2>
                    Выполнить задачу
                </h2>
            </div>
        </template>
        <!-- an automatic task names the deal and its company: the deal first, the company after it -->
        <NuxtLink :href="link" class="text-sm text-blue-600 underline dark:text-blue-400" v-if="task">
            {{ [
                task.deal ? `Сделка: ${task.deal.label}` : '',
                task.ctr_agent ? `Контакт: ${task.ctr_agent.username}` : '',
                task.company ? `Компания: ${task.company.name}` : '',
            ].filter(Boolean).join(' · ') }}
        </NuxtLink>
        <button @click="() => taskModal.open(task)" class="text-[15px] py-0.5 px-1.5 rounded-sm bg-primary-600/10 text-slate-900 block mt-1 dark:text-white dark:bg-primary-400" v-if="task">
            <span>{{ taskWhen(task.start, task.allDay) }}</span>
            <span class="ml-2">для {{ task.agent?.username || task.group?.name }}</span>
            <strong class="ml-2">{{ task.type?.name ?? 'Задача' }} </strong>&nbsp;&minus;&nbsp;<span>{{ task.label }}</span>
        </button>
        <form class="flex flex-col mt-2" id="task-result-form" @submit.prevent="onSave">
            <BaseInput label="Результат" name="result" required />
        </form>
        <template #footer>
            <div class="flex gap-2">
                <div class="flex-initial">
                    <BaseButton
                        class="btn-primary"
                        type="submit"
                        form="task-result-form"
                        :disabled="isLoading"
                    >
                        Выполнить
                    </BaseButton>
                </div>
            </div>
        </template>
    </Modal>
</template>

<script lang="ts" setup>
import Modal from '~/components/common/Modal.vue';
import type { Task } from '~/types/deal';

import { taskWhen } from './taskText';

const props = defineProps<{ id: string; }>();
const emit = defineEmits(['saved']);

const modal = useModal(props.id);
const taskModal = useModal('TaskModal');
const taskService = useService('tasks', {auth: true});
const task = ref<Task>();
const toast = useToast('GlobalToast');
const {isLoading, runAsync} = useAsync();

const link = computed(() => {
    if (task.value?.deal) return `/deals/${task.value.deal.id}`;
    if (task.value?.ctr_agent) return `/lists/contacts/${task.value.ctr_agent.id}`;
    if (task.value?.company) return `/lists/companies/${task.value.company.id}`;
});

async function onSave(e: Event) {
    if (!task.value) return;
    const target = e.target as HTMLFormElement;
    const data = new FormData(target);
    const result = data.get('result');
    const updateResult = await promiseResult(runAsync(taskService.patch(`${task.value.id}/close`, {result}).exec()));
    if (!updateResult.ok) return toast.show({message: updateResult.error.message, type: 'error', timeout: 3000});
    emit('saved');
    modal.close();
}

function onShown(data: Task) {
    task.value = data;
}

</script>

<style scoped>

</style>
