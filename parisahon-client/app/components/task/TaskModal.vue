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
                :items="linkableItems" 
                label="Компании, контакты или сделки" 
                placeholder="Поиск..." size="md"
                @input="onSearch"
                :properties="{
                    value: 'key',
                    label: 'name',
                    sublabel: (l: Linkable) => LINKABLE_KINDS[l.type] ?? '',
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

import { confirmTaskPlan, isTaskPlanCancelled } from './taskPlan';
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
    type: 'ctr_agent' | 'user' | 'company' | 'deal';
    // a company and a deal may have the same id: the list tells them apart by type and id
    key?: string;
}

const LINKABLE_KINDS: Record<string, string> = {
    deal: 'Сделка',
    company: 'Компания',
    user: 'Контакт',
    ctr_agent: 'Контакт',
};

function withKey(l: Linkable): Linkable {
    return {...l, key: `${l.type === 'user' ? 'ctr_agent' : l.type}-${l.id}`};
}

const linkableService = useService('/linkables', {auth: true});
const taskService = useService('/tasks', {auth: true});
const toast = useToast('GlobalToast');
const { data: linkables, run: runLinkables } = useAsync<Linkable[]>([]);
const { runAsync: saveTask, isLoading: saving } = useAsync();
const { runAsync: deleteTask, isLoading: deleting } = useAsync();
const linkable = ref<Linkable>();
const linkableItems = computed(() => (linkables.value ?? []).map(withKey));

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

    // a time in the past or a second task of the deal at the same time: the API asks, the user decides
    const id = task.value.id && task.value.id > 0 ? task.value.id : null;
    const send = (flags: Record<string, boolean>) => id
        ? taskService.patch(id, {...values, ...flags}).exec()
        : taskService.create({...values, ...flags}).exec();
    const result = await promiseResult(saveTask(confirmTaskPlan(send)));
    if (!result.ok) {
        if (!isTaskPlanCancelled(result.error)) toast.show({message: result.error.message, type: 'error', timeout: 5000});
        return;
    }
    closeModal();
}

// the deal first: an automatic task names the deal and its company, and the deal is what it is about
function shown(data: Task) {
    task.value = data;
    linkable.value = undefined;
    if (data.deal) {
        linkable.value = withKey({id: data.deal.id, name: data.deal.label, type: 'deal'});
    } else if (data.ctr_agent) {
        linkable.value = withKey({id: data.ctr_agent.id, name: data.ctr_agent.username, type: 'ctr_agent'});
    } else if (data.company) {
        linkable.value = withKey({id: data.company.id, name: data.company.name, type: 'company'});
    }
}

// useService encodes the query itself: encoding here too sent "%D0%9F..." and Cyrillic names were never found
const onSearch = debounce((e: Event) => {
    const value = (e.target as HTMLInputElement).value.trim();
    if (!value) return;
    runLinkables(linkableService.find({ name: value }).exec());
}, 300);

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
