<template>
    <BaseCard v-if="data && data.enabled" class="flex flex-col gap-4 p-6">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
            <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">
                Новые обращения
            </BaseHeading>
            <span class="text-sm text-muted-500 dark:text-muted-400">
                ИИ разбирает первое сообщение нового контакта. Ничего не удаляется: «не заявки» — здесь, для проверки
            </span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
            <BaseButtonGroup>
                <BaseButton
                    v-for="tab of TABS"
                    :key="tab.key"
                    size="sm"
                    color="default"
                    :class="category === tab.key ? 'toggle-selected' : ''"
                    @click="category = tab.key"
                >
                    {{ tab.label }}<template v-if="tabCount(tab.key) !== null"> · {{ tabCount(tab.key) }}</template>
                </BaseButton>
            </BaseButtonGroup>
            <label class="flex items-center gap-2 text-sm text-muted-600 dark:text-muted-300">
                <input v-model="onlyNew" type="checkbox" class="rounded border-muted-300" />
                только непросмотренные
            </label>
            <span class="text-sm text-muted-500 dark:text-muted-400">{{ countsLine }}</span>
        </div>

        <p v-if="!loading && !data.rows.length" class="text-sm text-muted-500 dark:text-muted-400">
            {{ category === 'not_lead' ? 'Все новые обращения за период — заявки или клиенты.' : 'Нет обращений за период.' }}
        </p>
        <ul class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700">
            <li v-for="row of data.rows" :key="row.id" class="flex flex-col gap-2 py-3 lg:flex-row lg:items-start lg:justify-between">
                <div class="flex min-w-0 flex-col gap-1 text-sm">
                    <div class="flex flex-wrap items-center gap-2">
                        <Icon :name="CHANNEL_ICON[row.channel] ?? 'ph:chat-text'" class="size-4 shrink-0 text-muted-400" />
                        <NuxtLink :to="`/deals/${row.deal.id}`" class="font-medium text-primary-600 hover:underline dark:text-primary-200">
                            №{{ row.deal.number ?? row.deal.id }} «{{ row.deal.label }}»
                        </NuxtLink>
                        <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="categoryClass(row.category)">{{ row.category_label }}</span>
                        <span v-if="row.corrected" class="text-xs text-muted-400" :title="'ИИ: ' + label(row.ai_category)">исправлено</span>
                        <span v-if="row.status === 'reviewed'" class="text-xs text-success-600">просмотрено{{ row.reviewed_by ? ' · ' + row.reviewed_by : '' }}</span>
                    </div>
                    <span class="text-muted-600 dark:text-muted-300">{{ row.line }}</span>
                    <span v-if="row.wants" class="text-muted-800 dark:text-muted-100">{{ row.wants }}</span>
                    <span v-if="row.quote" class="break-words italic text-muted-500 dark:text-muted-400">«{{ row.quote }}»</span>
                    <span class="text-xs text-muted-400">{{ stamp(row.created_at) }} · {{ row.agent || 'без ответственного' }}<template v-if="row.reason"> · {{ row.reason }}</template></span>
                </div>
                <div class="flex shrink-0 flex-wrap items-center gap-2">
                    <BaseSelect
                        :model-value="row.category"
                        :disabled="saving === row.id"
                        :classes="{ wrapper: 'w-40' }"
                        aria-label="Категория"
                        @update:model-value="(value) => save(row, { category: value })"
                    >
                        <option v-for="c of data.categories" :key="c.key" :value="c.key">{{ c.label }}</option>
                    </BaseSelect>
                    <BaseButton
                        v-if="row.status !== 'reviewed'"
                        size="sm"
                        variant="pastel"
                        :loading="saving === row.id"
                        :disabled="saving !== null"
                        @click="save(row, { reviewed: true })"
                    >
                        Просмотрено
                    </BaseButton>
                </div>
            </li>
        </ul>
        <div v-if="data.total > data.rows.length || page > 1" class="flex items-center gap-2 text-sm">
            <BaseButton size="sm" :disabled="page <= 1 || loading" @click="page--">‹ Назад</BaseButton>
            <span class="text-muted-500">стр. {{ page }} из {{ Math.max(1, Math.ceil(data.total / 50)) }}</span>
            <BaseButton size="sm" :disabled="page * 50 >= data.total || loading" @click="page++">Дальше ›</BaseButton>
        </div>
    </BaseCard>
</template>

<script lang="ts" setup>
/**
 * «Новые обращения» of the control page (parisahon-api/src/ai-insights/inbound.service.ts, GET /ai/inbound): what
 * the AI read in the first message of each new contact of the period — заявка, клиент, поставщик, личное, спам,
 * другое — with the client type, the country and «что хочет клиент». «Не заявки» first, for the owner to check:
 * the category is corrected here (PATCH /deals/:id/ai/inbound), a row is marked «просмотрено». Nothing is shown
 * while the AI feature is off and there are no readings.
 */
import moment from 'moment';
import { promiseResult } from '~/utils/result';

const props = defineProps<{ from?: string | null; till?: string | null }>();

type InboundRow = {
    id: number;
    deal: { id: number; number: number | null; label: string; closed: boolean };
    channel: string;
    category: string;
    category_label: string;
    ai_category: string;
    corrected: boolean;
    line: string;
    wants: string | null;
    quote: string | null;
    reason: string | null;
    status: string;
    reviewed_by: string | null;
    agent: string | null;
    created_at: string;
};
type InboundList = {
    enabled: boolean;
    categories: { key: string; label: string; count: number; unseen: number }[];
    total: number;
    rows: InboundRow[];
};

const TABS = [
    { key: 'not_lead', label: 'Не заявки' },
    { key: 'lead', label: 'Заявки' },
    { key: 'all', label: 'Все' },
];
const CHANNEL_ICON: Record<string, string> = { telegram: 'ph:telegram-logo', whatsapp: 'ph:whatsapp-logo', email: 'ph:envelope-simple' };

const service = useService('ai', { auth: true });
const deals = useService('deals', { auth: true });
const toast = useToast('GlobalToast');
const data = ref<InboundList | null>(null);
const loading = ref(false);
const saving = ref<number | null>(null);
const category = ref('not_lead');
const onlyNew = ref(false);
const page = ref(1);

async function load() {
    loading.value = true;
    const query: Record<string, any> = { category: category.value, status: onlyNew.value ? 'new' : 'all', page: page.value };
    if (props.from) query.from_date = props.from;
    if (props.till) query.till_date = props.till;
    const result = await promiseResult(service.get('inbound', query).exec());
    loading.value = false;
    if (result.ok) data.value = result.value as InboundList;
}

function tabCount(key: string): number | null {
    const list = data.value?.categories ?? [];
    if (key === 'all') return list.reduce((s, c) => s + c.count, 0);
    if (key === 'lead') return list.find((c) => c.key === 'lead')?.count ?? 0;
    return list.filter((c) => c.key !== 'lead').reduce((s, c) => s + c.count, 0);
}

const countsLine = computed(() =>
    (data.value?.categories ?? [])
        .filter((c) => c.count > 0)
        .map((c) => `${c.label} ${c.count}`)
        .join(' · '),
);

function label(key: string): string {
    return data.value?.categories.find((c) => c.key === key)?.label ?? key;
}

function categoryClass(key: string): string {
    if (key === 'lead') return 'bg-success-100 text-success-700 dark:bg-success-500/20 dark:text-success-300';
    if (key === 'client') return 'bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-200';
    if (key === 'spam') return 'bg-danger-100 text-danger-700 dark:bg-danger-500/20 dark:text-danger-300';
    return 'bg-muted-100 text-muted-700 dark:bg-muted-700 dark:text-muted-200';
}

function stamp(value: string): string {
    const m = moment(value);
    return m.isValid() ? (m.isSame(moment(), 'day') ? `сегодня ${m.format('HH:mm')}` : m.format('DD.MM.YYYY HH:mm')) : '';
}

async function save(row: InboundRow, change: { category?: string; reviewed?: boolean }) {
    if (change.category === row.category) return;
    saving.value = row.id;
    const result = await promiseResult(deals.patch(`${row.deal.id}/ai/inbound`, change).exec());
    saving.value = null;
    if (!result.ok) {
        toast.show({ message: result.error.message, type: 'error', timeout: 4000 });
        return;
    }
    await load();
}

watch(() => [props.from, props.till, category.value, onlyNew.value], () => {
    // a new filter starts on the first page (the page watcher loads it)
    if (page.value !== 1) page.value = 1;
    else load();
});
watch(page, load);
onMounted(load);

// a new reading or a correction on a deal page: the API says 'changed' {ai: [dealId]}
useLive((changes) => {
    if (changes.ai) load();
}, 3000);
</script>
