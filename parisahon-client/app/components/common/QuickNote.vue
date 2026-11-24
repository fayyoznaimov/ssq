<template>
    <!--
        A note under the history of a company or a contact card (SCR2-4): «клиент просил прайс» was
        written as a task «Встреча» due the minute the page was opened, and it went overdue.
        POST /companies/:id/comments or /users/:id/comments: a note of the card, outside any deal.
    -->
    <form class="w-full" @submit.prevent="save">
        <BaseTextarea
            v-model="text"
            :rows="3"
            addon
            resize
            size="lg"
            name="note"
            placeholder="Заметка: что сказал клиент, о чём договорились"
            :disabled="saving"
        >
            <template #addon>
                <BaseButton
                    size="sm"
                    type="submit"
                    color="primary"
                    :disabled="text.trim().length < 2 || saving"
                    :loading="saving"
                >
                    Сохранить заметку
                </BaseButton>
            </template>
        </BaseTextarea>
    </form>
</template>

<script setup lang="ts">
import type { DealEvent } from '~/types/deal';

const props = defineProps<{
    // the card: a company or a contact
    target: 'companies' | 'users';
    id: number;
}>();
const emit = defineEmits<{ saved: [event: DealEvent] }>();

const service = useService(props.target, { auth: true });
const toast = useToast('GlobalToast');
const text = ref('');
const saving = ref(false);

async function save() {
    const comment = text.value.trim();
    if (comment.length < 2 || saving.value || !props.id) return;
    saving.value = true;
    const result = await promiseResult(service.post(`${props.id}/comments`, { comment }).exec());
    saving.value = false;
    if (!result.ok) {
        toast.show({ message: result.error.message, timeout: 3000, type: 'error' });
        return;
    }
    text.value = '';
    emit('saved', result.value as DealEvent);
}
</script>
