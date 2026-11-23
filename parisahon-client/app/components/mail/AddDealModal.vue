<script setup lang="ts">
import Modal from '~/components/common/Modal.vue';
import { useValidation } from '~/composables/useValidation';
import type { PaginatedResponse } from '~/types/generics';
import type { DealFromLetters, Email } from '~/types/mail';
import type { Settings } from '~/types/settings';
import { type User,UserRole } from '~/types/user';
import { promiseResult } from '~/utils/result';
import { required } from '~/utils/validation';

/**
 * «доб.сделку» in Mail: a deal with the client of the chosen letters (POST /emails/deals). The
 * server finds the contact by the address (or makes one, named from the letter, in the company of
 * its domain), opens the deal in the chosen manager's name and puts these and the earlier letters
 * of the client into its history. One deal per client, however many letters are chosen.
 */
const props = defineProps<{ id: string, emails: Email[] }>();
const modal = useModal(props.id);
const emits = defineEmits<{
    (e: 'saved', value: DealFromLetters[]): void;
}>();

const toast = useToast('GlobalToast');
const {runAsync, isLoading} = useAsync();
const {run: runSettings, data: settings, isLoading: settingsLoading} = useAsync<Settings>();

const settingsService  = useService('settings', { auth: true });
const userService = useService('users', {auth: true});
const mailService = useService('emails', {auth: true});
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

/** The clients the deals are for: the sender, or the first recipient of a letter we sent. */
const clients = computed(() => {
    const seen = new Set<string>();
    for (const email of props.emails) {
        const raw = email.outgoing ? (email.to?.[0]?.value ?? '') : (email.from ?? '');
        const address = (raw.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/)?.[0] ?? raw).toLowerCase();
        if (address) seen.add(address);
    }
    return [...seen];
});

const {validate, onChange, errors} = useValidation({ agent: [required('Обязательное поле')] });

async function onSubmit(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const agentId = formData.get('agent[id]');
    const stageId = formData.get('stage_id');
    const validationResult = validate({
        agent: agentId,
    });

    if (!validationResult.valid) return;
    if (!props.emails.length) {
        return toast.show({message: 'Отметьте письма, из которых нужно создать сделку', type: 'error', timeout: 3000});
    }

    const result = await promiseResult(runAsync(mailService.post('deals', {
        email_ids: props.emails.map((email) => email.id),
        agent_id: Number(agentId),
        stage_id: stageId ? Number(stageId) : undefined,
    }).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 5000});

    const created = (result.value ?? []) as DealFromLetters[];
    toast.show({
        message: created.length === 1
            ? `Создана сделка «${created[0].deal.label}» с ${created[0].contact.username}, писем в истории: ${created[0].letters}`
            : `Создано сделок: ${created.length}`,
        type: 'success',
        timeout: 4000,
    });
    emits('saved', created);
    modal.close();
    if (created.length === 1) navigateTo('/deals/' + created[0].deal.id);
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
        <form @submit.prevent="onSubmit" id="deal-from-letters-form" class="flex flex-col gap-4">
            <p v-if="clients.length" class="text-sm text-muted-600 dark:text-muted-300">
                Сделка с клиентом {{ clients.join(', ') }}: контакт найдётся по адресу или будет создан, письма попадут в историю сделки.
            </p>
            <p v-else class="text-sm text-muted-500">Отметьте письма, из которых нужно создать сделку.</p>
            <input v-if="settings?.default_stage?.id" type="hidden" name="stage_id" :value="settings.default_stage.id">
            <BaseAutocomplete
                label="Ответственный"
                placeholder="Выбрать ответственного"
                :fixed="true"
                :items="employees"
                :properties="{label: 'username', value: 'id', sublabel: (u: User)  => u.group?.name}"
                dropdown
                :loading="usersLoading"
                required
                @change="(u: User) => onChange('agent', u?.id)"
                :error="errors.agent"
                name="agent"
            />
        </form>
        <template #footer>
            <div class="flex gap-2">
                <BaseButton
                    type="submit"
                    form="deal-from-letters-form"
                    color="primary"
                    :loading="isLoading"
                    :disabled="settingsLoading || isLoading || !clients.length"
                >
                    Создать
                </BaseButton>
                <BaseButton @click="modal.close">
                    Отменить
                </BaseButton>
            </div>
        </template>
    </Modal>
</template>
