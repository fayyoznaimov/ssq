<template>
    <!--
        The open tasks of the deal, in their own place at the top of the history card (owner's report:
        the block floated over the feed — sticky at the bottom of the scrolled card — and covered the
        messages). Folded to one line by default; the time without seconds; a click opens the task,
        «Выполнить» closes it with a result.
    -->
    <div class="shrink-0 border-b border-muted-200 dark:border-muted-700">
        <button
            type="button"
            class="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] text-muted-600 hover:bg-muted-50 dark:text-muted-300 dark:hover:bg-muted-700/40"
            :aria-expanded="open"
            @click="toggle"
        >
            <Icon name="ph:clock-countdown" class="size-4 shrink-0 text-primary-500" />
            <span class="font-medium text-muted-800 dark:text-muted-100">Запланировано: {{ tasksCount(sorted.length) }}</span>
            <span v-if="!open && sorted[0]" class="min-w-0 flex-1 truncate">
                · <span :class="isTaskOverdue(sorted[0]) ? 'text-danger-600 dark:text-danger-400' : ''">{{ whenOf(sorted[0]) }}</span>
                {{ titleOf(sorted[0]) }}
            </span>
            <span v-else class="flex-1" />
            <Icon :name="open ? 'ph:caret-up' : 'ph:caret-down'" class="size-4 shrink-0" />
        </button>
        <ul v-if="open" class="max-h-56 overflow-y-auto px-2 pb-2">
            <li v-for="task in sorted" :key="task.id" class="rounded-md hover:bg-muted-50 dark:hover:bg-muted-700/40">
                <div class="flex items-start gap-2 px-2 py-1.5 text-[13px]">
                    <button
                        type="button"
                        class="min-w-0 flex-1 text-left"
                        title="Открыть задачу"
                        @click="taskModal.open(task)"
                    >
                        <span class="whitespace-nowrap font-medium" :class="isTaskOverdue(task) ? 'text-danger-600 dark:text-danger-400' : 'text-muted-800 dark:text-muted-100'">{{ whenOf(task) }}</span>
                        <span v-if="overdueText(task)" class="ms-1 text-xs text-danger-600 dark:text-danger-400">({{ overdueText(task) }})</span>
                        <span class="text-muted-500 dark:text-muted-400"> · {{ task.agent?.username || task.group?.name || 'без исполнителя' }}</span>
                        <span class="block break-words text-muted-700 dark:text-muted-200">{{ titleOf(task) }}</span>
                    </button>
                    <BaseButton size="sm" class="shrink-0 !px-2 !py-1" @click="closing = closing === task.id ? null : task.id">
                        {{ closing === task.id ? 'Отмена' : 'Выполнить' }}
                    </BaseButton>
                </div>
                <form v-if="closing === task.id" class="flex items-center gap-2 px-2 pb-2" @submit.prevent="close(task)">
                    <BaseInput v-model="result" name="result" :classes="{ wrapper: 'w-full' }" placeholder="Итог: что сделано, о чём договорились" required />
                    <BaseButton type="submit" color="primary" size="sm" :loading="saving" :disabled="saving || !result.trim()">Готово</BaseButton>
                </form>
            </li>
        </ul>
        <TaskModal id="HistoryTaskModal" @save="emit('changed')" />
    </div>
</template>

<script setup lang="ts">
import BaseButton from '~/components/base/BaseButton.vue';
import BaseInput from '~/components/form/BaseInput.vue';
import TaskModal from '~/components/task/TaskModal.vue';
import { isTaskOverdue, overdueText, tasksCount, taskWhen } from '~/components/task/taskText';
import type { Task } from '~/types/deal';
import { promiseResult } from '~/utils/result';

const props = defineProps<{ tasks: Task[] }>();
const emit = defineEmits<{ (e: 'changed'): void }>();

const OPEN_KEY = 'history.plannedTasks.open';
const open = ref(false);
onMounted(() => {
    try {
        open.value = localStorage.getItem(OPEN_KEY) === '1';
    } catch {
        open.value = false;
    }
});
function toggle() {
    open.value = !open.value;
    try {
        localStorage.setItem(OPEN_KEY, open.value ? '1' : '0');
    } catch {
        // private mode: the choice lasts until the page is left
    }
}

const taskModal = useModal('HistoryTaskModal');
const taskService = useService('tasks', { auth: true });
const toast = useToast('GlobalToast');
const closing = ref<number | null>(null);
const result = ref('');
const saving = ref(false);

const timeOf = (task: Task) => new Date(task.end_time || task.end || task.start_time || task.start || 0).getTime();
// the nearest first; the open ones only (a closed task has closed_at)
const sorted = computed(() => [...(props.tasks ?? [])].filter((t) => !t.closed_at).sort((a, b) => timeOf(a) - timeOf(b)));

function whenOf(task: Task): string {
    return taskWhen(task.end_time || task.end || task.start_time || task.start, !!task.allDay);
}

function titleOf(task: Task): string {
    const type = task.type?.name || 'Задача';
    return task.label ? `${type}: ${task.label}` : type;
}

async function close(task: Task) {
    const text = result.value.trim();
    if (!text) return;
    saving.value = true;
    const answer = await promiseResult(taskService.patch(`${task.id}/close`, { result: text }).exec());
    saving.value = false;
    if (!answer.ok) {
        toast.show({ message: answer.error.message, timeout: 4000, type: 'error' });
        return;
    }
    closing.value = null;
    result.value = '';
    emit('changed');
}
</script>
