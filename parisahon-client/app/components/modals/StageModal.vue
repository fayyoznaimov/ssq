<template>
    <Modal
        :id="props.id"
    >
        <template #header>
            <div class="flex">
                <h2>
                    Изменить этап
                </h2>
            </div>
        </template>
        <div>
            <BaseListbox 
                :items="data" 
                :properties="{label: 'name', value: 'id' }"
                label="Этапы"
                v-model="selectedStage"
                :loading="isLoading"
            />
        </div>
        <template #footer>
            <div class="flex gap-2">
                <div class="flex-initial">
                    <BaseButton
                        class="btn-primary"
                        @click="save"
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

const props = defineProps<{ id: string; }>();
const emit = defineEmits(['saved']);

const selectedStage = ref();
const modal = useModal(props.id);
const stageService = useService('stages', {auth: true});
const {data, isLoading, run} = useAsync();

onMounted(() => {
    run(stageService.find().exec());
});

function save() {
    emit('saved', selectedStage.value);
    modal.close();
}

</script>

<style scoped>

</style>
