<script setup lang="ts">
import Modal from '~/components/common/Modal.vue';
import { useValidation } from '~/composables/useValidation';
import type { PaginatedResponse } from '~/types/generics';
import type { Email } from '~/types/mail';
import type { Settings } from '~/types/settings';
import { type User,UserRole } from '~/types/user';
import { promiseResult } from '~/utils/result';
import { required } from '~/utils/validation';

const props = defineProps<{ id: string, emails: Email[] }>();
const modal = useModal(props.id);
const emits = defineEmits<{
    (e: 'saved', value: User, isNew: boolean): void;
}>();

const toast = useToast('GlobalToast');
const {runAsync, isLoading} = useAsync();
const {run: runSettings, data: settings, isLoading: settingsLoading} = useAsync<Settings>();

const settingsService  = useService('settings', { auth: true });
const userService = useService('users', {auth: true});
const dealService = useService('deals', {auth: true});
const {run, data: users, isLoading: usersLoading} = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});

const employees = computed(() => {
    return users.value.data.filter((u) => u.role !== UserRole.CtrAgent);
});

const {validate, onChange, errors} = useValidation({ agent: [required('Обязательное поле')] });

async function onSubmit(e: Event) {
    // TODO: FIX THIS, REMOVE CONSTANTS;
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const agentId = formData.get('agent[id]');
    const stageId = formData.get('stage_id');
    const validationResult = validate({
        agent: agentId,
    });

    if (!validationResult.valid) return;
    const promises = props.emails.map((email) => dealService.create({
        label: '',
        budget: 0,
        agent_id: Number(agentId),
        ctr_agent_ids: [],
        fillers: [],
        products: [],
        stage_id: Number(stageId),
    }).exec());

    const result = await promiseResult(runAsync(Promise.all(promises)));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    modal.close();
}

onMounted(() => {
    run(userService.find({limit: 1000}).exec());
    runSettings(settingsService.find().exec());
});

</script>
<template>
    <Modal :id="props.id" size="md">
        <template #header>
            <div class="flex">
                <h2>Создать сделку</h2>
            </div>
        </template>
        <form @submit.prevent="onSubmit" id="contact-form">
            <input v-if="settings.default_stage.id" type="hidden" name="stage_id" v-model="settings.default_stage.id">
            <BaseAutocomplete 
                label="Ответственный"
                placeholder="Выбрать ответственного" 
                :fixed="true" 
                :items="employees" 
                :properties="{label: 'username', value: 'id', sublabel: (u: User)  => u.group?.name}" 
                dropdown 
                :loading="usersLoading"
                required
                @change="(u: User) => onChange('agent', u.id)"
                :error="errors.agent"
                name="agent"
            />
        </form>
        <template #footer>
            <div class="flex gap-2">
                <BaseButton
                    type="submit"
                    form="contact-form"
                    color="primary"
                    :loading="isLoading"
                    :disabled="settingsLoading"
                >
                    Сохранить
                </BaseButton>
                <BaseButton @click="modal.close">
                    Отменить
                </BaseButton>
            </div>
        </template>
    </Modal>
</template>
