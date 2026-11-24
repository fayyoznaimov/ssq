<template>
    <section v-if="view?.inbound" class="rounded-lg border border-muted-200 bg-white p-3 dark:border-muted-700 dark:bg-muted-800">
        <header class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-500 dark:text-muted-400">Первое обращение</h3>
            <BaseSelect
                v-if="canUpdate"
                :model-value="view.inbound.category"
                :disabled="saving"
                :classes="{ wrapper: 'w-40' }"
                aria-label="Категория обращения"
                @update:model-value="(value) => save(value)"
            >
                <option v-for="c of view.categories" :key="c.key" :value="c.key">{{ c.label }}</option>
            </BaseSelect>
        </header>
        <p class="font-medium text-muted-900 dark:text-white">{{ view.inbound.line }}</p>
        <p v-if="view.inbound.wants" class="mt-1"><span class="text-xs text-muted-500 dark:text-muted-400">Что хочет клиент: </span>{{ view.inbound.wants }}</p>
        <p v-if="view.inbound.quote" class="mt-1 break-words text-xs italic text-muted-500 dark:text-muted-400">«{{ view.inbound.quote }}»</p>
        <p class="mt-1 text-xs text-muted-400">
            {{ CHANNELS[view.inbound.channel] ?? view.inbound.channel }} · {{ stamp(view.inbound.created_at) }}<template v-if="view.inbound.corrected"> · категория исправлена</template>
        </p>
    </section>
    <p v-else-if="view?.reading" class="rounded-md bg-primary-50 px-3 py-2 text-primary-700 dark:bg-primary-500/10 dark:text-primary-200">
        ИИ разбирает первое обращение клиента…
    </p>
</template>

<script lang="ts" setup>
/**
 * «Первое обращение» of the deal's «ИИ» tab (parisahon-api/src/ai-insights/inbound.service.ts): what the AI read in
 * the first message of the new contact — заявка / клиент / поставщик / личное / спам / другое, the client type, the
 * country, the language and «что хочет клиент». Whoever may change the deal corrects the category here. Nothing is
 * shown for a deal without such a reading.
 */
import moment from 'moment';
import { promiseResult } from '~/utils/result';

const props = defineProps<{ dealId?: number | string | null; canUpdate?: boolean }>();

type InboundView = {
    enabled: boolean;
    reading: boolean;
    categories: { key: string; label: string }[];
    inbound: {
        category: string;
        line: string;
        wants: string | null;
        quote: string | null;
        channel: string;
        corrected: boolean;
        created_at: string;
    } | null;
};

const CHANNELS: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', email: 'письмо' };
const deals = useService('deals', { auth: true });
const toast = useToast('GlobalToast');
const view = ref<InboundView | null>(null);
const saving = ref(false);

async function load() {
    if (!props.dealId) {
        view.value = null;
        return;
    }
    const current = String(props.dealId);
    const result = await promiseResult(deals.get(`${current}/ai/inbound`).exec());
    if (String(props.dealId) !== current) return;
    view.value = result.ok ? (result.value as InboundView) : null;
}

async function save(category: string) {
    if (!props.dealId || !view.value?.inbound || category === view.value.inbound.category) return;
    saving.value = true;
    const result = await promiseResult(deals.patch(`${props.dealId}/ai/inbound`, { category }).exec());
    saving.value = false;
    if (!result.ok) {
        toast.show({ message: result.error.message, type: 'error', timeout: 4000 });
        return;
    }
    toast.show({ message: 'Категория обращения исправлена', type: 'success', timeout: 2500 });
    load();
}

function stamp(value: string): string {
    const m = moment(value);
    return m.isValid() ? m.format('DD.MM.YYYY HH:mm') : '';
}

watch(() => props.dealId, load, { immediate: true });

// the reading is ready, or corrected elsewhere: 'changed' {ai: [dealId]}
useLive((changes) => {
    if (liveTouches(changes, 'ai', props.dealId ?? null)) load();
}, 1000);
</script>
