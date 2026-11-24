<template>
    <div v-if="state !== 'off'" class="rounded-md border border-primary-200 bg-primary-50/60 px-3 py-2 text-sm dark:border-primary-500/30 dark:bg-primary-500/10">
        <p v-if="state === 'loading'" class="flex items-center gap-2 text-primary-700 dark:text-primary-200">
            <Icon name="ph:sparkle" class="size-4 shrink-0" />
            ИИ читает переписку и подбирает причину…
        </p>
        <template v-else-if="state === 'ready' && proposal">
            <div class="flex flex-wrap items-start justify-between gap-2">
                <p class="min-w-0 flex-1 text-muted-800 dark:text-muted-100">
                    <Icon name="ph:sparkle" class="me-1 inline size-4 text-primary-500" />
                    <template v-if="proposal.reason">ИИ предлагает: <span class="font-semibold">{{ proposal.reason }}</span><template v-if="proposal.comment"> — {{ proposal.comment }}</template></template>
                    <template v-else>{{ proposal.comment || 'По переписке причина не видна' }}</template>
                </p>
                <BaseButton v-if="proposal.reason" size="sm" color="primary" variant="pastel" type="button" @click="apply">Принять</BaseButton>
            </div>
            <p v-if="proposal.quote" class="mt-1 break-words text-xs italic text-muted-600 dark:text-muted-300">
                «{{ proposal.quote }}»<template v-if="quoteRef"> — {{ quoteRef.from === 'client' ? 'клиент' : quoteRef.from === 'note' ? 'заметка' : 'менеджер' }}, {{ stamp(quoteRef.at) }}</template>
            </p>
            <p class="mt-1 text-xs text-muted-400">{{ proposal.confidence === 'high' ? 'Клиент сказал об этом прямо.' : 'Это догадка ИИ — проверьте.' }} Причину сохраняете вы.</p>
        </template>
        <p v-else-if="state === 'error'" class="text-xs text-muted-500 dark:text-muted-400">{{ error }}</p>
    </div>
</template>

<script lang="ts" setup>
/**
 * «Почему сделка не реализована?» with the AI (parisahon-api/src/ai-insights/lost.service.ts): the AI proposes the
 * reason of the lost deal from its conversation — one of the list, a short comment and the client's words — and the
 * manager takes it into the form with «Принять» (it is saved only by «Сохранить причину», PATCH /deals/:id/lost).
 * Shown only while the feature is on; the request is the manager's (POST /deals/:id/ai/lost-reason, cached for the
 * same conversation); a proposal still being made is asked for again every few seconds.
 */
import moment from 'moment';
import { promiseResult } from '~/utils/result';

const props = defineProps<{ dealId: number | string }>();
const emit = defineEmits<{ (e: 'apply', value: { reason: string; comment: string }): void }>();

type Proposal = { reason: string | null; comment: string; quote: string | null; event_id: number | null; confidence: 'high' | 'low' };
type LostState = {
    enabled?: boolean;
    status: string;
    data: Proposal | null;
    ref: { at: string; from: string; channel: string; excerpt: string } | null;
    error: string | null;
};

const deals = useService('deals', { auth: true });
const state = ref<'off' | 'loading' | 'ready' | 'error'>('off');
const proposal = ref<Proposal | null>(null);
const quoteRef = ref<LostState['ref']>(null);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;
let until = 0;
let alive = true;

function show(value: LostState): boolean {
    if (value.status === 'done' && value.data) {
        proposal.value = value.data;
        quoteRef.value = value.ref;
        state.value = 'ready';
        return true;
    }
    if (value.status === 'queued' || value.status === 'running') {
        state.value = 'loading';
        return false;
    }
    if (value.error) {
        error.value = value.error;
        state.value = 'error';
        return true;
    }
    state.value = 'off';
    return true;
}

async function poll() {
    timer = null;
    if (!alive) return;
    const result = await promiseResult(deals.get(`${props.dealId}/ai/lost-reason`).exec());
    if (!alive) return;
    if (!result.ok) {
        state.value = 'off';
        return;
    }
    if (!show(result.value as LostState) && Date.now() < until) timer = setTimeout(poll, 4000);
    else if (state.value === 'loading') {
        error.value = 'ИИ не успел подобрать причину — выберите её сами';
        state.value = 'error';
    }
}

async function start() {
    const first = await promiseResult(deals.get(`${props.dealId}/ai/lost-reason`).exec());
    if (!alive || !first.ok) return;
    const value = first.value as LostState;
    // off, or the deal is not in the lost stage: nothing to show
    if (value.enabled === false || value.status === 'not_lost') return;
    if (show(value) && value.status === 'done') return;
    state.value = 'loading';
    until = Date.now() + 2 * 60_000;
    const asked = await promiseResult(deals.post(`${props.dealId}/ai/lost-reason`, {}).exec());
    if (!alive) return;
    if (!asked.ok) {
        // paused (503) or the hourly limit: a short note, the form works as before
        error.value = asked.error?.message || 'ИИ сейчас недоступен';
        state.value = 'error';
        return;
    }
    if (!show(asked.value as LostState)) timer = setTimeout(poll, 4000);
}

function apply() {
    if (!proposal.value?.reason) return;
    const parts = [proposal.value.comment, proposal.value.quote ? `клиент: «${proposal.value.quote}»` : ''].filter(Boolean);
    emit('apply', { reason: proposal.value.reason, comment: parts.join('; ').slice(0, 1000) });
}

function stamp(value: string): string {
    const m = moment(value);
    return m.isValid() ? m.format('DD.MM.YYYY HH:mm') : '';
}

onMounted(start);
onBeforeUnmount(() => {
    alive = false;
    if (timer) clearTimeout(timer);
});
</script>
