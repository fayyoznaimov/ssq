<template>
    <!-- «История изменений» of a card (a deal, a company, a contact, an employee): the same view as the journal page
         (pages/analytics/events), only this card's records, with the card's own visibility (GET /audit/<scope>/:id) -->
    <section class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
            <div class="flex shrink-0 rounded-full bg-muted-100 p-0.5 text-sm dark:bg-muted-700/60" role="group" aria-label="Что показать">
                <button
                    v-for="option in kinds"
                    :key="option.id"
                    type="button"
                    class="rounded-full px-3 py-1 transition-colors"
                    :class="kind === option.id
                        ? 'bg-white font-medium text-primary-700 shadow-sm dark:bg-muted-900 dark:text-primary-300'
                        : 'text-muted-600 hover:text-muted-900 dark:text-muted-300 dark:hover:text-white'"
                    :aria-pressed="kind === option.id"
                    @click="kind = option.id"
                >{{ option.label }}</button>
            </div>
            <!-- an employee: the changes of the account (rights, logins) or what the employee did -->
            <div v-if="staff" class="flex shrink-0 rounded-full bg-muted-100 p-0.5 text-sm dark:bg-muted-700/60" role="group" aria-label="Чьи записи">
                <button
                    v-for="option in views"
                    :key="option.id"
                    type="button"
                    class="rounded-full px-3 py-1 transition-colors"
                    :class="view === option.id
                        ? 'bg-white font-medium text-primary-700 shadow-sm dark:bg-muted-900 dark:text-primary-300'
                        : 'text-muted-600 hover:text-muted-900 dark:text-muted-300 dark:hover:text-white'"
                    :aria-pressed="view === option.id"
                    @click="view = option.id"
                >{{ option.label }}</button>
            </div>
            <!-- the narrow column of a card is small to read: the same history in a wide window -->
            <BaseButton
                v-if="items.length"
                size="sm"
                class="shrink-0"
                title="Открыть историю в большом окне"
                @click="wide.open()"
            >
                <Icon name="ph:arrows-out" class="size-4" />
                <span class="ms-1">Крупно</span>
            </BaseButton>
            <div class="relative w-full min-w-0 sm:w-56 sm:flex-1">
                <Icon name="ph:magnifying-glass" class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-400" />
                <input
                    v-model="text"
                    type="search"
                    maxlength="100"
                    class="h-9 w-full rounded-full border border-muted-200 bg-white pe-3 ps-8 text-sm text-muted-800 placeholder:text-muted-400 focus:border-primary-500 focus:outline-none dark:border-muted-600 dark:bg-muted-900 dark:text-muted-100"
                    placeholder="Поиск: текст, значение, имя"
                    aria-label="Поиск в истории изменений"
                    @keydown.enter.prevent="applySearch"
                    @search="applySearch"
                >
            </div>
        </div>

        <p v-if="error" class="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-danger-700 dark:text-danger-300">
            {{ error }}
        </p>
        <div v-else-if="loading && !items.length" class="flex flex-col gap-2">
            <BasePlaceload v-for="n in 3" :key="n" class="h-16 w-full rounded-lg" />
        </div>
        <p v-else-if="!items.length" class="py-6 text-center text-sm text-muted-500 dark:text-muted-400">
            {{ q ? 'Ничего не найдено' : kind === 'changes' ? 'Изменений пока нет' : 'Записей пока нет' }}
        </p>
        <AuditList v-else :days="days" compact />

        <div v-if="items.length < count" class="flex justify-center">
            <BaseButton size="sm" :loading="loading" :disabled="loading" @click="loadMore">
                Показать ещё ({{ count - items.length }})
            </BaseButton>
        </div>
        <p v-if="journalStart && !loading" class="text-xs text-muted-500 dark:text-muted-400">
            Изменения данных записываются с {{ ddmmyyyy(journalStart) }}; более ранние видны только среди событий.
        </p>

        <Modal :id="modalId" size="3xl">
            <template #header>
                <h2 class="text-lg text-muted-900 dark:text-white">{{ kind === 'changes' ? 'История изменений' : 'История событий' }}</h2>
            </template>
            <div class="max-h-[75vh] overflow-y-auto pe-1">
                <AuditList :days="days" />
                <div v-if="items.length < count" class="mt-4 flex justify-center">
                    <BaseButton size="sm" :loading="loading" :disabled="loading" @click="loadMore">
                        Показать ещё ({{ count - items.length }})
                    </BaseButton>
                </div>
            </div>
        </Modal>
    </section>
</template>

<script setup lang="ts">
import AuditList from './AuditList.vue';
import Modal from '~/components/common/Modal.vue';
import { type AuditItem, type AuditKind, type AuditPage, ddmmyyyy, groupHistory } from './audit';
import { liveTouches, useLive, type LiveChanges } from '~/composables/useLive';

const props = withDefaults(defineProps<{
    scope: 'deal' | 'company' | 'user';
    id: number | string;
    /** an employee's card: «Учётная запись / Действия» */
    staff?: boolean;
}>(), {
    staff: false,
});

const PAGE = 20;
// one window per card on the page
const modalId = `AuditHistoryModal-${props.scope}-${props.id}`;
const wide = useModal(modalId);
const kinds: { id: AuditKind; label: string }[] = [
    { id: 'changes', label: 'Изменения' },
    { id: 'all', label: 'Всё' },
];
const views: { id: 'account' | 'actor'; label: string }[] = [
    { id: 'account', label: 'Учётная запись' },
    { id: 'actor', label: 'Действия сотрудника' },
];

const service = useService('audit', { auth: true });
const kind = ref<AuditKind>('changes');
const view = ref<'account' | 'actor'>('account');
const text = ref('');
const q = ref('');
const items = ref<AuditItem[]>([]);
const count = ref(0);
const journalStart = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
let generation = 0;

const days = computed(() => groupHistory(items.value));

function query(skip: number, limit: number): Record<string, any> {
    const out: Record<string, any> = { kind: kind.value, skip, limit };
    if (q.value) out.q = q.value;
    if (props.staff && props.scope === 'user' && view.value === 'actor') out.as = 'actor';
    return out;
}

/** The first page again (or as many rows as are shown: a live refresh keeps «Показать ещё» where it was). */
async function load(keep = false) {
    if (!props.id) return;
    const mine = ++generation;
    loading.value = true;
    error.value = '';
    const limit = keep ? Math.min(Math.max(items.value.length, PAGE), 200) : PAGE;
    try {
        const page = await service.get<AuditPage>(`${props.scope}/${props.id}`, query(0, limit) as any).exec();
        if (mine !== generation) return;
        items.value = page.data ?? [];
        count.value = page.count ?? 0;
        journalStart.value = page.journal_start ?? null;
    } catch (e: any) {
        if (mine === generation) error.value = e?.message || 'Не удалось загрузить историю изменений';
    } finally {
        if (mine === generation) loading.value = false;
    }
}

async function loadMore() {
    const mine = ++generation;
    loading.value = true;
    try {
        const page = await service.get<AuditPage>(`${props.scope}/${props.id}`, query(items.value.length, PAGE) as any).exec();
        if (mine !== generation) return;
        const seen = new Set(items.value.map((item) => item.id));
        items.value = [...items.value, ...(page.data ?? []).filter((item) => !seen.has(item.id))];
        count.value = page.count ?? count.value;
    } catch (e: any) {
        if (mine === generation) error.value = e?.message || 'Не удалось загрузить историю изменений';
    } finally {
        if (mine === generation) loading.value = false;
    }
}

function applySearch() {
    const value = text.value.trim();
    if (value === q.value) return;
    q.value = value;
}

watch([kind, view, q, () => props.id], () => load());
onMounted(() => load());

// a change made meanwhile (here or by somebody else) shows up by itself
useLive((changes: LiveChanges) => {
    const id = Number(props.id);
    const touched = props.scope === 'deal'
        ? liveTouches(changes, 'deals', id) || liveTouches(changes, 'events', id) || liveTouches(changes, 'tasks', id) || liveTouches(changes, 'files')
        : Object.keys(changes).length > 0;
    if (touched) load(true);
});
</script>
