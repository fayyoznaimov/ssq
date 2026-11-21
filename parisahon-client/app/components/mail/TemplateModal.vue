<script setup lang="ts">
import Modal from '~/components/common/Modal.vue';
import type { Template } from '~/types/mail';
import { promiseResult } from '~/utils/result';

const toast = useToast('GlobalToast');
const templateService = useService('emails/templates', { auth: true });
const {isLoadingMap, runWithId} = useAsync<Template>();
const props = defineProps<{ id: string }>();
const modal = useModal(props.id);
const template = ref<Partial<Template>>({});
const emits = defineEmits<{
    (e: 'saved', value: Template, isNew: boolean): void;
    (e: 'deleted', id: number): void;
}>();

async function onSubmit(e: Event) {
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const id = data.get('id') as string;
    const values: Partial<Template> = {
        name: data.get('name') as string,
        template_body: data.get('body') as string,
        subject: data.get('subject') as string,
    };
    let promise;
    if (id) promise = templateService.patch(id, values).exec();
    else promise = templateService.create(values).exec();
    const result = await promiseResult<Template>(runWithId(promise, 'saving'));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    values.id = result.value.id;
    emits('saved', values as Template, !id);
    modal.close();
}

async function onDelete() {
    const result = await promiseResult(runWithId(templateService.remove(template.value.id!).exec(), 'deleting'));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    emits('deleted', template.value.id!);
    modal.close();
}

</script>
<template>
    <Modal :id="props.id" size="lg" @shown="(data) => template = data">
        <template #header>
            <div class="flex">
                <h2>
                    {{ template.id ? 'Редактировать шаблон' : 'Создать шаблон' }}
                </h2>
            </div>
        </template>
        <form @submit.prevent="onSubmit" id="template-form">
            <input v-if="template" type="hidden" name="id" :value="template.id" />
            <div class="flex flex-col space-y-6">
                <BaseInput name="name" label="Название" v-model="template.name" />
                <BaseInput name="subject" label="Тема письма" v-model="template.subject" />
                <BaseTextarea name="body" label="Письмо" v-model="template.template_body" />
            </div>
        </form>
        <template #footer>
            <div class="flex gap-2">
                <BaseButton color="danger" :disabled="isLoadingMap.deleting" @click="onDelete">
                    Удалить
                </BaseButton>
                <BaseButton
                    type="submit"
                    form="template-form"
                    color="primary"
                    :disabled="isLoadingMap.saving"
                >
                    Сохранить
                </BaseButton>
            </div>
        </template>
    </Modal>
</template>
