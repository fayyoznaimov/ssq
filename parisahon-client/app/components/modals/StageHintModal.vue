<template>
    <Modal :id="props.id" size="xl">
        <template #header>
            <div class="flex">
                <h2>
                    Подсказки для этапа &laquo;{{ props.stage.name }}&raquo;
                </h2>
            </div>
        </template>
        <form class="flex flex-col space-y-6" id="stage-hint-form" @submit.prevent="onSubmit">
            <div>
                <input type="hidden" name="id" :value="props.stage.id" />
                <div class="mb-2.5">
                    <span class="font-medium block text-muted-900 dark:text-white">Описание</span>
                    <span class="text-gray-600 text-sm dark:text-muted-400">Для всех пользователей системы ParisaCRM</span>
                </div>
                <BaseTextarea
                    name="description"
                    size="md"
                    placeholder="Описание"
                    v-model="description"
                    :resize="false"
                    :autogrow="true"
                />
            </div>
        </form>
        <template #footer>
            <div class="flex gap-2">
                <div class="flex-initial">
                    <BaseButton
                        type="submit"
                        form="stage-hint-form"
                        class="btn-primary"
                        @click="onSubmit"
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
import type { Modify } from '~/types/generics';
import type {Stage} from '~/types/stage';

type CustomStage = Modify<Stage, {
    status: string;
}>

const props = defineProps<{ stage: CustomStage; id: string }>();
const description = computed(() => props.stage?.description);
const modal = useModal(props.id);
const emit = defineEmits(['update']);

function onSubmit(e: Event) {
    let target = e.target as HTMLButtonElement;
    if (!target.form) return;
    let data = Object.fromEntries(new FormData(target.form));
    modal.close();
    emit('update', data);
}

</script>
