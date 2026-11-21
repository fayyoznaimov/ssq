<script setup lang="ts">
import Modal from '~/components/common/Modal.vue';
import { promiseResult } from '~/utils/result';

const {runAsync, isLoading} = useAsync();
const toast = useToast('GlobalToast');
const props = defineProps<{ id: string, title: string, description: string, onConfirm: () => Promise<any> }>();
const description = toRef(props.description);
const title = toRef(props.title);
const modal = useModal(props.id);

async function onSubmit() {
    const result = await promiseResult(runAsync(props.onConfirm()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    modal.close();
}

function onShown(data: any) {
    if (data.description) description.value = data.description;
}

</script>
<template>
    <Modal :id="props.id" @shown="onShown">
        <template #header>
            <h2 class="text-lg text-muted-900 dark:text-white">{{ title }}</h2>
        </template>
        <p class="text-[15px] text-muted-600 dark:text-muted-200">{{ description }}</p>
        <template #footer>
            <div class="flex gap-2">
                <BaseButton variant="solid" color="primary" :disabled="isLoading" @click="onSubmit">
                    Подтвердить
                </BaseButton>
                <BaseButton @click="modal.close">
                    Отменить
                </BaseButton>
            </div>
        </template>
    </Modal>
</template>
