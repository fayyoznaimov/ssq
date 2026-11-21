<template>
    <Modal
        :id="props.id"
        @shown="shown"
        size="2xl"
    >
        <form @submit.prevent="onDelete" id="delete-form"></form>
        <form @submit.prevent="onSubmit" class="flex flex-col gap-4" novalidate>
            <BaseAutocomplete 
                v-model="linkable"
                name="linkable"
                :items="linkables" 
                label="Компании, контакты или сделки" 
                placeholder="Поиск..." size="md"
                @input="onSearch"
                :properties="{
                    value: 'id',
                    label: 'name',
                }"
                dropdown
                required
                :error="errors.linkable"
                @change="(l: Linkable) => onChange('linkable', l.id)"
            />
            <EventSchedulerSingle :agent="task.agent || user" :group="task.group" v-model="task" size="md" :initial-date="task.start" />
            <BaseTextarea 
                label="Описание" 
                size="md" 
                name="label" 
                v-model="task.label" 
                required 
                :error="errors.label" 
                @input="(e: Event) => onChange('label', (e.target as HTMLTextAreaElement).value)"
            />
            <div class="flex gap-2 justify-between">
                <div class="flex gap-2">
                    <BaseButton color="primary" type="submit" :disabled="saving">Подтвердить</BaseButton>
                    <BaseButton @click="modal.close" :disabled="saving">Отменить</BaseButton>
                </div>
                <BaseButton v-if="task.id && task.id > 0" color="danger" form="delete-form" type="submit" :disabled="deleting">
                    Удалить
                </BaseButton>
            </div>
        </form>
    </Modal>
</template>

<script lang="ts" setup>
import BaseButton from '~/components/base/BaseButton.vue';
import EventSchedulerSingle from '~/components/common/EventSchedulerSingle.vue';
import Modal from '~/components/common/Modal.vue';
import BaseTextarea from '~/components/form/BaseTextarea.vue';
import { useValidation } from '~/composables/useValidation';
import type { Task } from '~/types/deal';
import type { User } from '~/types/user';
import { promiseResult } from '~/utils/result';
import { minLength,required } from '~/utils/validation';

const props = defineProps<{
    id: string;
}>();

const task = ref<Partial<Task>>({});
const modal = useModal(props.id);
const emit = defineEmits(['save']);
const user = useState<User>('user');

type Linkable = {
    id: number;
    name: string;
    type: 'ctr_agent' | 'company' | 'deal';
}

const linkableService = useService('/linkables', {auth: true});
const taskService = useService('/tasks', {auth: true});
const toast = useToast('GlobalToast');
const { data: linkables, run: runLinkables } = useAsync<Linkable[]>([]);
const { runAsync: saveTask, isLoading: saving } = useAsync();
const { runAsync: deleteTask, isLoading: deleting } = useAsync();
const linkable = ref<Linkable>();

const { validate, errors, onChange } = useValidation({
    linkable: [required('Обязательное поле')],
    label: [required('Обязательное поле'), minLength(3, 'Описание не должно быть меньше трех символов')]
});

async function onDelete() {
    const result = await promiseResult(deleteTask(taskService.remove(task.value.id!).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    closeModal();
}

async function onSubmit(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const label = formData.get('label');
    const typeId = formData.get('type[id]');
    const assignTarget = formData.get('assignee[target]');
    const assignId = formData.get('assignee[id]');
    const linkId = formData.get('linkable[id]');
    const startTime = formData.get('start');
    const endTime = formData.get('end');
    const allDay = formData.get('allDay') != null;
    let linkTarget = formData.get('linkable[type]');

    const validationResult = validate({
        label,
        linkable: linkable.value?.id,
    });

    if (!validationResult.valid) return;

    if (linkTarget === 'user') linkTarget = 'ctr_agent';

    const values = {
        label,
        type_id: Number(typeId),
        link_to: {
            target: linkTarget,
            id: Number(linkId),
        },
        assign_to: {
            target: assignTarget,
            id: Number(assignId),
        },
        start_time: startTime,
        end_time: endTime,
        allDay: allDay,
    };

    let promise;
    if (task.value.id && task.value?.id > 0) promise = taskService.patch(task.value.id, values).exec();
    else promise = taskService.create(values).exec();
    const result = await promiseResult(saveTask(promise));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    closeModal();
}

function shown(data: Task) {
    task.value = data;
    if (data.ctr_agent) {
        linkable.value = {id: data.ctr_agent.id, name: data.ctr_agent.username, type: 'ctr_agent'};
    } else if (data.company) {
        linkable.value = {id: data.company.id, name: data.company.name, type: 'company'};
    } else if (data.deal) {
        linkable.value = {id: data.deal.id, name: data.deal.label, type: 'deal'};
    }
}

function onSearch(e: Event) {
    const target = (e.target as HTMLInputElement);
    runLinkables(linkableService.find({ name: encodeURIComponent(target.value) }).exec());
}

function closeModal() {
    emit('save');
    modal.close();
}

onMounted(() => {
    runLinkables(linkableService.find({name: 'a'}).exec());
});

</script>

<style scoped>
</style>
