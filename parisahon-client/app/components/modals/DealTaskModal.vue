<template>
    <Modal
        :id="props.id"
        size="xl"
    >
        <template #header>
            <div class="flex">
                <h2>
                    Добавить задачу
                </h2>
            </div>
        </template>
        <form class="flex flex-col gap-4" id="deal-task-form" @submit.prevent="onSave">
            <EventSchedulerSingle v-model="task" :agent="user" />
            <BaseTextarea 
                label="Описание" 
                size="md" 
                name="label" 
                v-model="task.label" 
                required 
            />
        </form>
        <template #footer>
            <div class="flex gap-2">
                <div class="flex-initial">
                    <BaseButton
                        class="btn-primary"
                        form="deal-task-form"
                        type="submit"
                    >
                        Сохранить
                    </BaseButton>
                </div>
            </div>
        </template>
    </Modal>
</template>

<script lang="ts" setup>
import Modal from '~/components/common/Modal.vue';
import type { Task } from '~/types/deal';
import type { Group, User } from '~/types/user';

import EventSchedulerSingle from '../common/EventSchedulerSingle.vue';

const props = defineProps<{ id: string; }>();
const emit = defineEmits(['saved']);

const modal = useModal(props.id);
const end = new Date();
const start = new Date().toISOString();
end.setMinutes(end.getMinutes() + 30);
const endStr = end.toISOString();

const user = useState<User>('user');
const task = ref<Partial<Task>>({
    id: -1,
    label:  '',
    result: null,
    closed_at: '',
    start_time: start,
    start: start,
    end: endStr,
    end_time: endStr,
    created_at: new Date().toISOString(),
    allDay: false
});

function onSave(e: Event) {
    const target = e.target as HTMLFormElement;
    const data = new FormData(target);
    const assigneeId = Number(data.get('assignee[id]'));
    const assigneeTarget = data.get('assignee[target]');
    if (assigneeTarget === 'agent') {
        task.value.agent = {id: assigneeId} as User;
    }
    if (assigneeTarget === 'group') {
        task.value.group = {id: assigneeId} as Group;
    }

    emit('saved', task.value);
    modal.close();
}

</script>

<style scoped>

</style>
