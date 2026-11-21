<template>
    <Modal
        :id="props.id"
    >
        <template #header>
            <div class="flex">
                <h2>
                    Изменить ответственного
                </h2>
            </div>
        </template>
        <div>
            <BaseListbox 
                :items="employees" 
                :properties="{label: 'username', value: 'id' }"
                label="Ответственный"
                v-model="selectedAgent"
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
import type { PaginatedResponse } from '~/types/generics';
import { type User,UserRole } from '~/types/user';

const props = defineProps<{ id: string; }>();
const emit = defineEmits(['saved']);

const selectedAgent = ref();
const modal = useModal(props.id);
const userService = useService('users', {auth: true});
const { run, data: users, isLoading } = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});

const employees = computed(() => {
    return users.value.data.filter((u) => u.role !== UserRole.CtrAgent);
});

onMounted(() => {
    run(userService.find({limit: 1000}).exec());
});

function save() {
    emit('saved', selectedAgent.value);
    modal.close();
}

</script>

<style scoped>

</style>
