<template>
    <!-- «История событий» of the whole CRM (admin, manager): the business events and the changes of data together,
         filters by period, author, kind of object, kind of change, source and words (GET /audit) -->
    <div class="flex flex-col gap-5">
        <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
                <div class="flex shrink-0 rounded-full bg-muted-100 p-0.5 text-sm dark:bg-muted-700/60" role="group" aria-label="Что показать">
                    <button
                        v-for="option in kinds"
                        :key="option.id"
                        type="button"
                        class="rounded-full px-3 py-1 transition-colors"
                        :class="filters.kind === option.id
                            ? 'bg-white font-medium text-primary-700 shadow-sm dark:bg-muted-900 dark:text-primary-300'
                            : 'text-muted-600 hover:text-muted-900 dark:text-muted-300 dark:hover:text-white'"
                        :aria-pressed="filters.kind === option.id"
                        @click="setKind(option.id)"
                    >{{ option.label }}</button>
                </div>
                <div class="w-full sm:w-64">
                    <DatePicker
                        v-model="filters.dates"
                        format="dd.MM.yyyy"
                        range
                        text-input
                        :preset-dates="presetDates"
                        auto-apply
                        :enable-time-picker="false"
                        model-type="yyyy-MM-dd"
                        :teleport="true"
                        :dark="isDarkMode"
                        locale="ru"
                        select-text="Выбрать"
                        cancel-text="Отмена"
                    >
                        <template #dp-input="{ onInput, value, onBlur, onPaste }">
                            <BaseInput :value="value" icon="ph:calendar-blank" placeholder="Период: за всё время" @input="onInput" @blur="onBlur" @paste="onPaste" />
                        </template>
                    </DatePicker>
                </div>
                <div class="relative w-full sm:w-64">
                    <Icon name="ph:magnifying-glass" class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-400" />
                    <input
                        v-model="text"
                        type="search"
                        maxlength="100"
                        class="h-10 w-full rounded-md border border-muted-200 bg-white pe-3 ps-8 text-sm text-muted-800 placeholder:text-muted-400 focus:border-primary-500 focus:outline-none dark:border-muted-600 dark:bg-muted-900 dark:text-muted-100"
                        placeholder="Поиск: текст, значение, имя"
                        aria-label="Поиск в истории"
                        @keydown.enter.prevent="applySearch"
                        @search="applySearch"
                    >
                </div>
                <TairoPopover fixed size="2md">
                    <BaseButton>
                        <Icon name="ph:funnel" />
                        <span class="ms-1">Фильтры</span>
                        <span v-if="panelCount" class="ms-1 inline-flex min-w-[1.25rem] justify-center rounded-full bg-primary-500 px-1 text-xs text-white">{{ panelCount }}</span>
                    </BaseButton>
                    <template #content="{ close }">
                        <form class="flex w-full flex-col gap-3 p-4" @submit.prevent="applyPanel(close)">
                            <BaseAutocomplete
                                v-model="filters.author"
                                placeholder="Кто: все сотрудники"
                                :fixed="true"
                                :items="employees"
                                :properties="{ label: 'username', value: 'id', sublabel: (u: any) => u.group?.name }"
                                dropdown
                                clearable
                            />
                            <BaseListbox
                                v-model="filters.entities"
                                :items="meta.entities"
                                :properties="{ label: 'name', value: 'key' }"
                                multiple
                                :fixed="true"
                                placeholder="Объекты: все"
                                :multiple-label="(value: any[], prop: string) => value.length ? value.map((v) => v[prop]).join(', ') : undefined"
                            />
                            <BaseListbox
                                v-model="filters.actions"
                                :items="meta.actions"
                                :properties="{ label: 'name', value: 'key' }"
                                multiple
                                :fixed="true"
                                placeholder="Что сделано: всё"
                                :multiple-label="(value: any[], prop: string) => value.length ? value.map((v) => v[prop]).join(', ') : undefined"
                            />
                            <BaseListbox
                                v-model="filters.sources"
                                :items="meta.sources"
                                :properties="{ label: 'name', value: 'key' }"
                                multiple
                                :fixed="true"
                                placeholder="Откуда: отовсюду"
                                :multiple-label="(value: any[], prop: string) => value.length ? value.map((v) => v[prop]).join(', ') : undefined"
                            />
                            <BaseListbox
                                v-model="filters.types"
                                :items="EVENT_TYPES"
                                :properties="{ label: 'label', value: 'id' }"
                                multiple
                                :fixed="true"
                                placeholder="Типы событий: все"
                                :multiple-label="(value: any[], prop: string) => value.length ? value.map((v) => v[prop]).join(', ') : undefined"
                            />
                            <p class="text-xs text-muted-500 dark:text-muted-400">
                                Объекты, виды изменений и источники выбирают изменения данных; типы событий — события.
                            </p>
                            <BaseButton type="submit" color="primary">Применить</BaseButton>
                        </form>
                    </template>
                </TairoPopover>
                <PerPageSelect v-model="perPage" />
            </div>
            <!-- what the history is filtered by: seen, each removable -->
            <div v-if="chips.length" class="flex flex-wrap items-center gap-2 text-sm">
                <button
                    v-for="chip in chips"
                    :key="chip.key"
                    type="button"
                    class="inline-flex items-center gap-1 rounded-full border border-muted-300 px-3 py-1 text-muted-700 hover:border-primary-500 dark:border-muted-600 dark:text-muted-200"
                    title="Убрать фильтр"
                    @click="removeChip(chip.key)"
                >
                    {{ chip.label }} <Icon name="ph:x" class="size-3" />
                </button>
                <button type="button" class="text-primary-600 underline dark:text-primary-300" @click="resetAll">Сбросить всё</button>
            </div>
        </div>

        <p v-if="error" class="rounded-md bg-danger-500/10 px-3 py-2 text-sm text-danger-700 dark:text-danger-300">{{ error }}</p>
        <div v-else-if="loading && !page.data.length" class="flex flex-col gap-2">
            <BasePlaceload v-for="n in 5" :key="n" class="h-20 w-full rounded-lg" />
        </div>
        <p v-else-if="!page.data.length" class="py-10 text-center text-sm text-muted-500 dark:text-muted-400">
            За выбранный период записей нет
        </p>
        <AuditList v-else :days="days" :class="loading ? 'opacity-60' : ''" />

        <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="text-sm text-muted-500 dark:text-muted-400">
                {{ changesWord(page.count) }}<template v-if="page.journal_start">; изменения данных записываются с {{ ddmmyyyy(page.journal_start) }}</template>
            </p>
            <BasePagination
                v-if="page.count > perPage"
                v-model:current-page="currentPage"
                :item-per-page="perPage"
                :total-items="page.count"
                :max-links-displayed="7"
                shape="rounded"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import DatePicker from '@vuepic/vue-datepicker';
import moment from 'moment';

import AuditList from './AuditList.vue';
import { EVENT_TYPES, type AuditKind, type AuditMeta, type AuditPage, changesWord, ddmmyyyy, groupHistory } from './audit';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import TairoPopover from '~/components/tairo/TairoPopover.vue';
import { useLive } from '~/composables/useLive';
import { personName } from '~/components/common/feed';

const props = withDefaults(defineProps<{
    /** /analytics/events?deal_id=12: one deal */
    dealId?: number | null;
}>(), {
    dealId: null,
});
const emit = defineEmits<{ (e: 'update:dealId', value: number | null): void }>();

interface Filters {
    kind: AuditKind;
    dates: string[];
    author: any;
    entities: { key: string; name: string }[];
    actions: { key: string; name: string }[];
    sources: { key: string; name: string }[];
    types: { id: number; label: string }[];
    q: string;
}

const kinds: { id: AuditKind; label: string }[] = [
    { id: 'all', label: 'Всё' },
    { id: 'changes', label: 'Изменения данных' },
    { id: 'events', label: 'События' },
];

const app = useAppConfig();
const route = useRoute();
const router = useRouter();
const isDarkMode = useDarkMode();
const auditService = useService('audit', { auth: true });
const userService = useService('users', { auth: true });

const empty = (): Filters => ({ kind: 'all', dates: [], author: undefined, entities: [], actions: [], sources: [], types: [], q: '' });
const filters = reactive<Filters>(empty());
const text = ref('');
const perPage = ref<number>(app.pagination?.defaultPageSize ?? 25);
const currentPage = ref(Number(route.query.page) > 0 ? Number(route.query.page) : 1);
const page = ref<AuditPage>({ data: [], count: 0, page_size: 25, current_page: 1, last_page: 0, journal_start: null });
const meta = ref<AuditMeta>({ entities: [], actions: [], sources: [] });
const employees = ref<any[]>([]);
const loading = ref(false);
const error = ref('');
let generation = 0;

const days = computed(() => groupHistory(page.value.data));

// periods are inclusive days: «за сегодня» is today only
const day = (value: moment.MomentInput) => moment(value).format('YYYY-MM-DD');
const presetDates = [
    { label: 'За сегодня', value: [day(moment()), day(moment())] },
    { label: 'За вчера', value: [day(moment().subtract(1, 'day')), day(moment().subtract(1, 'day'))] },
    { label: 'За последние 7 дней', value: [day(moment().subtract(6, 'day')), day(moment())] },
    { label: 'За последние 30 дней', value: [day(moment().subtract(29, 'day')), day(moment())] },
    { label: 'За этот месяц', value: [day(moment().startOf('month')), day(moment().endOf('month'))] },
    { label: 'За прошлый месяц', value: [day(moment().subtract(1, 'month').startOf('month')), day(moment().subtract(1, 'month').endOf('month'))] },
    { label: 'За этот год', value: [day(moment().startOf('year')), day(moment().endOf('year'))] },
];

const panelCount = computed(() =>
    (filters.author?.id ? 1 : 0) + (filters.entities.length ? 1 : 0) + (filters.actions.length ? 1 : 0)
    + (filters.sources.length ? 1 : 0) + (filters.types.length ? 1 : 0));

const chips = computed(() => {
    const out: { key: string; label: string }[] = [];
    if (filters.dates?.length === 2 && filters.dates[0]) {
        const [from, to] = filters.dates.map((d) => moment(d).format('DD.MM.YYYY'));
        out.push({ key: 'dates', label: from === to ? `Период: ${from}` : `Период: ${from} – ${to}` });
    }
    if (filters.author?.id) out.push({ key: 'author', label: `Кто: ${personName(filters.author)}` });
    if (filters.entities.length) out.push({ key: 'entities', label: `Объекты: ${filters.entities.map((e) => e.name).join(', ')}` });
    if (filters.actions.length) out.push({ key: 'actions', label: `Что сделано: ${filters.actions.map((e) => e.name).join(', ')}` });
    if (filters.sources.length) out.push({ key: 'sources', label: `Откуда: ${filters.sources.map((e) => e.name).join(', ')}` });
    if (filters.types.length) out.push({ key: 'types', label: `События: ${filters.types.map((e) => e.label).join(', ')}` });
    if (filters.q) out.push({ key: 'q', label: `Поиск: «${filters.q}»` });
    if (props.dealId) out.push({ key: 'deal', label: `Сделка: только №${props.dealId}` });
    return out;
});

function query(): Record<string, any> {
    const out: Record<string, any> = {
        kind: filters.kind,
        limit: perPage.value,
        skip: (currentPage.value - 1) * perPage.value,
    };
    if (filters.dates?.length === 2 && filters.dates[0] && filters.dates[1]) {
        out.from = day(filters.dates[0]);
        out.till = day(filters.dates[1]);
    }
    if (filters.author?.id) out.actor_id = filters.author.id;
    if (filters.kind !== 'events') {
        if (filters.entities.length) out.entity = filters.entities.map((e) => e.key);
        if (filters.actions.length) out.action = filters.actions.map((e) => e.key);
        if (filters.sources.length) out.source = filters.sources.map((e) => e.key);
    }
    if (filters.kind !== 'changes' && filters.types.length) out.event_types = filters.types.map((t) => t.id);
    if (filters.q) out.q = filters.q;
    if (props.dealId) out.deal_id = props.dealId;
    return out;
}

async function load() {
    const mine = ++generation;
    loading.value = true;
    error.value = '';
    try {
        const result = await auditService.find<AuditPage>(query() as any).exec();
        if (mine !== generation) return;
        page.value = { ...page.value, ...result, data: result?.data ?? [] };
    } catch (e: any) {
        if (mine === generation) error.value = e?.message || 'Не удалось загрузить историю';
    } finally {
        if (mine === generation) loading.value = false;
    }
}

function reload() {
    if (currentPage.value !== 1) currentPage.value = 1; // the watch loads
    else load();
}

function setKind(kind: AuditKind) {
    if (filters.kind === kind) return;
    filters.kind = kind;
    reload();
}

function applySearch() {
    const value = text.value.trim();
    if (value === filters.q) return;
    filters.q = value;
    reload();
}

function applyPanel(close: () => void) {
    reload();
    close();
}

function removeChip(key: string) {
    if (key === 'dates') filters.dates = []; // its own watch reloads
    else if (key === 'deal') {
        emit('update:dealId', null);
        return;
    } else {
        if (key === 'author') filters.author = undefined;
        if (key === 'entities') filters.entities = [];
        if (key === 'actions') filters.actions = [];
        if (key === 'sources') filters.sources = [];
        if (key === 'types') filters.types = [];
        if (key === 'q') {
            filters.q = '';
            text.value = '';
        }
        reload();
    }
}

function resetAll() {
    Object.assign(filters, empty());
    text.value = '';
    if (props.dealId) emit('update:dealId', null);
    else reload();
}

watch(() => (filters.dates ?? []).join('|'), reload);
watch(perPage, reload);
watch(() => props.dealId, reload);
watch(currentPage, (value) => {
    load();
    router.replace({ query: { ...route.query, page: value > 1 ? String(value) : undefined } }).catch(() => undefined);
});

onMounted(() => {
    load();
    auditService.get<AuditMeta>('meta').exec().then((value) => (meta.value = value)).catch(() => undefined);
    userService.find<any>({ limit: 1000 } as any).exec()
        .then((value: any) => (employees.value = (value?.data ?? []).filter((u: any) => u.role !== 'ctr_agent')))
        .catch(() => undefined);
});

// the page follows what happens in the CRM: a new change or event shows up at once on the first page
useLive(() => {
    if (currentPage.value === 1) load();
});
</script>
