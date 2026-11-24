<template>
    <Modal :id="LOST_REASON_MODAL" size="md" @shown="onShown" @hidden="onHidden">
        <template #header>
            <h2 class="text-base font-semibold text-muted-800 dark:text-white">Почему сделка не реализована?</h2>
        </template>
        <form class="flex flex-col gap-4" novalidate @submit.prevent="save">
            <p v-if="request?.deal" class="text-sm text-muted-500 dark:text-muted-400">
                Сделка № {{ request.deal.display_id ?? request.deal.id }}<template v-if="request.deal.label"> «{{ request.deal.label }}»</template>.
                Причина попадёт в историю сделки и в отчёты.
            </p>
            <!-- the AI's proposal from the conversation (src/ai-insights), taken into the form by «Принять» -->
            <AiLostHint v-if="request?.deal?.id" :key="request.deal.id" :deal-id="request.deal.id" @apply="applyAi" />
            <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Причина">
                <button
                    v-for="item in reasons"
                    :key="item"
                    type="button"
                    role="radio"
                    :aria-checked="reason === item"
                    class="rounded-full border px-3 py-1.5 text-sm transition-colors"
                    :class="reason === item
                        ? 'border-primary-500 bg-primary-500/10 font-medium text-primary-700 dark:border-primary-400 dark:bg-primary-500/20 dark:text-primary-200'
                        : 'border-muted-200 text-muted-700 hover:border-muted-400 dark:border-muted-600 dark:text-muted-200'"
                    @click="reason = item"
                >{{ item }}</button>
            </div>
            <BaseTextarea
                v-model="comment"
                name="lost_comment"
                :rows="3"
                maxlength="1000"
                :label="reason === OTHER ? 'Комментарий*' : 'Комментарий'"
                placeholder="Например: у конкурента на 10% дешевле, сроки 2 недели"
            />
            <p v-if="error" class="text-sm text-danger-600 dark:text-danger-400">{{ error }}</p>
            <div class="flex flex-wrap justify-end gap-2">
                <BaseButton type="button" :disabled="saving" @click="close">Не указывать</BaseButton>
                <BaseButton type="submit" color="primary" :loading="saving" :disabled="saving || !reason">Сохранить причину</BaseButton>
            </div>
        </form>
    </Modal>
</template>

<script setup lang="ts">
import BaseButton from '~/components/base/BaseButton.vue';
import Modal from '~/components/common/Modal.vue';
import BaseTextarea from '~/components/form/BaseTextarea.vue';
import { promiseResult } from '~/utils/result';
import AiLostHint from '~/components/ai-insights/AiLostHint.vue';
import { DEFAULT_LOST_REASONS } from './history';
import { LOST_REASON_MODAL, type LostReasonAnswer, type LostReasonRequest, lostReasonModalMounted } from './lostReason';

const OTHER = 'Другое';
const dealService = useService('deals', { auth: true });
const modal = useModal(LOST_REASON_MODAL);

const request = ref<LostReasonRequest | null>(null);
const reason = ref('');
const comment = ref('');
const error = ref('');
const saving = ref(false);
let answered = false;

const reasons = computed(() => (request.value?.reasons?.length ? request.value.reasons : DEFAULT_LOST_REASONS));

let unregister: (() => void) | undefined;
onMounted(() => {
    unregister = lostReasonModalMounted();
});
onBeforeUnmount(() => {
    unregister?.();
    finish(null);
});

function onShown(data: LostReasonRequest) {
    // a request that is still open is answered «not given» before the next one
    if (request.value && !answered) request.value.resolve(null);
    request.value = data;
    answered = false;
    reason.value = data?.reason && reasons.value.includes(data.reason) ? data.reason : '';
    comment.value = data?.comment ?? '';
    error.value = '';
}

function finish(answer: LostReasonAnswer) {
    if (request.value && !answered) {
        answered = true;
        request.value.resolve(answer);
    }
}

function onHidden() {
    finish(null);
}

/** «Принять» of the AI's proposal: the reason and the comment go into the form (saved by «Сохранить причину») */
function applyAi(value: { reason: string; comment: string }) {
    if (reasons.value.includes(value.reason)) reason.value = value.reason;
    if (!comment.value.trim()) comment.value = value.comment;
    error.value = '';
}

function close() {
    finish(null);
    modal.close();
}

async function save() {
    if (!request.value || !reason.value) return;
    const text = comment.value.trim();
    if (reason.value === OTHER && !text) {
        error.value = 'Для причины «Другое» напишите комментарий';
        return;
    }
    saving.value = true;
    error.value = '';
    const result = await promiseResult(dealService.patch(`${request.value.deal.id}/lost`, { reason: reason.value, comment: text || undefined }).exec());
    saving.value = false;
    if (!result.ok) {
        error.value = result.error?.message || 'Не удалось сохранить причину';
        return;
    }
    finish({ lost_reason: reason.value, lost_comment: text || null });
    modal.close();
}
</script>
