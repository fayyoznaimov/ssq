<template>
    <!-- On top of the history: what to show («Всё / Переписка / Звонки / Задачи / Изменения»), the search, and on a
         deal of a client with other deals «Эта сделка / Весь клиент» (DEAL-7, DEAL-10). Wraps on a phone. -->
    <div class="shrink-0 border-b border-muted-200 px-3 py-2 dark:border-muted-700">
        <div class="flex flex-wrap items-center gap-2">
            <div v-if="clientDeals > 0" class="flex shrink-0 rounded-full bg-muted-100 p-0.5 text-[13px] dark:bg-muted-700/60" role="group" aria-label="Чья история">
                <button
                    v-for="option in scopes"
                    :key="option.id"
                    type="button"
                    class="rounded-full px-3 py-1 transition-colors"
                    :class="scope === option.id
                        ? 'bg-white font-medium text-primary-700 shadow-sm dark:bg-muted-900 dark:text-primary-300'
                        : 'text-muted-600 hover:text-muted-900 dark:text-muted-300 dark:hover:text-white'"
                    :aria-pressed="scope === option.id"
                    @click="emit('update:scope', option.id)"
                >{{ option.label }}</button>
            </div>
            <div class="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 no-scrollbar" role="group" aria-label="Что показать">
                <button
                    v-for="kind in HISTORY_KINDS"
                    :key="kind.id"
                    type="button"
                    class="inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[13px] transition-colors"
                    :class="modelValue.kind === kind.id
                        ? 'border-primary-500 bg-primary-500/10 font-medium text-primary-700 dark:border-primary-400 dark:bg-primary-500/20 dark:text-primary-200'
                        : 'border-muted-200 text-muted-600 hover:border-muted-300 hover:text-muted-900 dark:border-muted-600 dark:text-muted-300 dark:hover:text-white'"
                    :aria-pressed="modelValue.kind === kind.id"
                    @click="setKind(kind.id)"
                >
                    <Icon :name="kind.icon" class="size-4" />{{ kind.label }}
                </button>
            </div>
            <div class="relative w-full sm:w-56 lg:w-64">
                <Icon name="ph:magnifying-glass" class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-400" />
                <input
                    v-model="text"
                    type="search"
                    class="h-8 w-full rounded-full border border-muted-200 bg-white pe-3 ps-8 text-[13px] text-muted-800 placeholder:text-muted-400 focus:border-primary-500 focus:outline-none dark:border-muted-600 dark:bg-muted-900 dark:text-muted-100"
                    placeholder="Поиск в истории"
                    aria-label="Поиск в истории"
                    maxlength="100"
                    @keydown.enter.prevent="apply"
                    @keydown.esc="clear"
                >
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { HISTORY_KINDS, type HistoryFilters, type HistoryKind } from './history';

const props = withDefaults(defineProps<{
    modelValue: HistoryFilters;
    // the deal page: «Эта сделка / Весь клиент» when the client has other deals the user may see
    scope?: 'deal' | 'client';
    clientDeals?: number;
}>(), {
    scope: 'deal',
    clientDeals: 0,
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: HistoryFilters): void;
    (e: 'update:scope', value: 'deal' | 'client'): void;
}>();

const scopes = computed(() => [
    { id: 'deal' as const, label: 'Эта сделка' },
    { id: 'client' as const, label: `Весь клиент · ${props.clientDeals + 1}` },
]);

const text = ref(props.modelValue.q ?? '');
watch(() => props.modelValue.q, (q) => {
    if ((q ?? '') !== text.value.trim()) text.value = q ?? '';
});

function setKind(kind: HistoryKind) {
    if (kind === props.modelValue.kind) return;
    emit('update:modelValue', { ...props.modelValue, kind });
}

function apply() {
    const q = text.value.trim();
    // one letter finds everything: the search starts with two
    const next = q.length >= 2 ? q : '';
    if (next === (props.modelValue.q ?? '')) return;
    emit('update:modelValue', { ...props.modelValue, q: next });
}

function clear() {
    text.value = '';
    apply();
}

let timer: ReturnType<typeof setTimeout> | undefined;
watch(text, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, 450);
});
onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
});
</script>
