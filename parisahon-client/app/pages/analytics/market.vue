<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <div>
                <h1 class="text-xl">Рынок</h1>
                <h2 class="text-sm text-muted-500">Что клиенты говорят о ценах и предложениях конкурентов — только по переписке в CRM</h2>
            </div>
            <PeriodPicker v-model="period" />
            <BaseSelect v-model="productId" :classes="{ wrapper: 'w-full sm:w-56' }" aria-label="Товар">
                <option value="">Все товары</option>
                <option v-for="p in productOptions" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
            </BaseSelect>
            <BaseInput
                v-model="productText"
                icon="ph:magnifying-glass"
                placeholder="Изделие, размер, граммаж"
                :classes="{ wrapper: 'w-full sm:w-56' }"
            />
            <BaseSelect v-model="country" :classes="{ wrapper: 'w-full sm:w-48' }" aria-label="Страна">
                <option value="">Все страны</option>
                <option v-for="c in countryOptions" :key="c" :value="c">{{ c }}</option>
            </BaseSelect>
        </div>

        <div v-if="!report && loading" class="flex flex-col gap-4">
            <BasePlaceload class="h-24 w-full rounded-lg" />
            <BasePlaceload class="h-48 w-full rounded-lg" />
        </div>

        <p v-else-if="loadError && !report" class="text-sm text-danger-600 dark:text-danger-400">{{ loadError }}</p>

        <BaseCard v-else-if="report && !report.enabled" class="p-6 text-sm text-muted-500 dark:text-muted-400">
            «Рынок» собирается ИИ из переписки с клиентами и работает, когда администратор включил ИИ-функции CRM (AI_FEATURES и AI_MARKET).
        </BaseCard>

        <template v-else-if="report">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <BaseCard class="flex flex-col gap-2 p-6">
                    <span class="text-xs font-semibold uppercase text-muted-500 dark:text-muted-300">Цены конкурентов</span>
                    <span class="text-3xl font-semibold text-muted-800 dark:text-white">{{ report.counts.competitor ?? 0 }}</span>
                    <span class="text-sm text-muted-500 dark:text-muted-400">раз клиенты назвали чужое предложение</span>
                </BaseCard>
                <BaseCard class="flex flex-col gap-2 p-6">
                    <span class="text-xs font-semibold uppercase text-muted-500 dark:text-muted-300">Цена клиента</span>
                    <span class="text-3xl font-semibold text-muted-800 dark:text-white">{{ report.counts.client_target ?? 0 }}</span>
                    <span class="text-sm text-muted-500 dark:text-muted-400">раз клиент назвал цену, которую хочет</span>
                </BaseCard>
                <BaseCard class="flex flex-col gap-2 p-6">
                    <span class="text-xs font-semibold uppercase text-muted-500 dark:text-muted-300">«Дорого»</span>
                    <span class="text-3xl font-semibold" :class="(report.counts.flags?.price_objection ?? 0) > 0 ? 'text-orange-500' : 'text-muted-800 dark:text-white'">
                        {{ report.counts.flags?.price_objection ?? 0 }}
                    </span>
                    <span class="text-sm text-muted-500 dark:text-muted-400">разговоров, где клиенту дорого</span>
                </BaseCard>
                <BaseCard class="flex flex-col gap-2 p-6">
                    <span class="text-xs font-semibold uppercase text-muted-500 dark:text-muted-300">Скидка и конкуренты</span>
                    <span class="text-3xl font-semibold text-muted-800 dark:text-white">
                        {{ report.counts.flags?.discount ?? 0 }} / {{ report.counts.flags?.competitor ?? 0 }}
                    </span>
                    <span class="text-sm text-muted-500 dark:text-muted-400">просят скидку / упоминают конкурента</span>
                </BaseCard>
            </div>

            <!-- the AI summary on demand -->
            <BaseCard class="flex flex-col gap-3 p-6">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">
                        Сводка ИИ: где мы дороже, где дешевле
                    </BaseHeading>
                    <BaseButton
                        size="sm"
                        variant="pastel"
                        color="primary"
                        :loading="summarizing"
                        :disabled="summarizing || !hasData"
                        @click="makeSummary"
                    >
                        <Icon name="ph:sparkle" class="me-1 size-4" />
                        {{ summary?.data ? 'Обновить' : 'Сделать сводку' }}
                    </BaseButton>
                </div>
                <template v-if="summary?.data">
                    <ul v-if="summary.data.lines.length" class="flex list-disc flex-col gap-1 ps-5 text-sm text-muted-800 dark:text-muted-100">
                        <li v-for="(line, i) in summary.data.lines" :key="'l' + i">{{ line }}</li>
                    </ul>
                    <div class="grid grid-cols-1 gap-4 text-sm lg:grid-cols-3">
                        <div v-if="summary.data.dearer.length">
                            <p class="mb-1 text-xs font-semibold uppercase text-danger-500">Мы дороже</p>
                            <p v-for="(d, i) in summary.data.dearer" :key="'d' + i"><span class="font-medium">{{ d.product }}:</span> {{ d.note }}</p>
                        </div>
                        <div v-if="summary.data.cheaper.length">
                            <p class="mb-1 text-xs font-semibold uppercase text-success-600">Мы дешевле или на уровне</p>
                            <p v-for="(d, i) in summary.data.cheaper" :key="'c' + i"><span class="font-medium">{{ d.product }}:</span> {{ d.note }}</p>
                        </div>
                        <div v-if="summary.data.said.length">
                            <p class="mb-1 text-xs font-semibold uppercase text-muted-500">Что говорят клиенты</p>
                            <p v-for="(s, i) in summary.data.said" :key="'s' + i">{{ s }}</p>
                        </div>
                    </div>
                    <p class="text-xs text-muted-400">
                        {{ summary.made_at ? 'Сделана ' + stamp(summary.made_at) : '' }}<template v-if="updating"> · готовлю новую…</template><template v-else-if="!summary.fresh"> · данные с тех пор изменились, нажмите «Обновить»</template>
                    </p>
                </template>
                <p v-else-if="updating" class="text-sm text-muted-500 dark:text-muted-400">Готовлю сводку, это займёт до минуты…</p>
                <p v-else-if="summaryError" class="text-sm text-muted-500 dark:text-muted-400">{{ summaryError }}</p>
                <p v-else class="text-sm text-muted-500 dark:text-muted-400">
                    {{ hasData ? 'Коротко по данным ниже: где наши цены выше или ниже, чем называют клиенты, и что они говорят о конкурентах.' : 'За этот период клиенты ничего не говорили о ценах и конкурентах.' }}
                </p>
            </BaseCard>

            <!-- per product -->
            <BaseCard class="flex flex-col gap-4 p-6">
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">По товарам</BaseHeading>
                    <span class="text-sm text-muted-500 dark:text-muted-400">
                        Наши цены — в {{ currencyLabel }}: по прайсу и в сделках за год.
                        <template v-if="report.compared_currencies.length < 2">Цены в другой валюте не сравниваются (курс не задан).</template>
                    </span>
                </div>
                <p v-if="!report.groups.length" class="text-sm text-muted-500 dark:text-muted-400">Клиенты не называли цены конкурентов за этот период.</p>
                <div v-else class="overflow-x-auto">
                    <table class="w-full min-w-[720px] text-left text-sm">
                        <thead class="text-xs uppercase text-muted-500 dark:text-muted-400">
                            <tr class="border-b border-muted-200 dark:border-muted-700">
                                <th class="py-2 pe-3 font-semibold">Товар</th>
                                <th class="py-2 pe-3 font-semibold">Наша цена</th>
                                <th class="py-2 pe-3 font-semibold">У конкурентов</th>
                                <th class="py-2 pe-3 font-semibold">Хочет клиент</th>
                                <th class="py-2 pe-3 font-semibold">Разница</th>
                                <th class="py-2 font-semibold">Упоминаний</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-muted-200 dark:divide-muted-700">
                            <tr v-for="g in report.groups" :key="g.key" class="align-top">
                                <td class="py-2 pe-3">
                                    <span class="font-medium text-muted-800 dark:text-white">{{ g.name }}</span>
                                    <span v-if="g.unit" class="text-muted-400"> · за {{ g.unit }}</span>
                                    <div v-if="g.suppliers.length || g.countries.length" class="text-xs text-muted-500 dark:text-muted-400">
                                        {{ [...g.suppliers, ...g.countries].join(', ') }}
                                    </div>
                                </td>
                                <td class="py-2 pe-3">
                                    <div v-if="g.deals_avg !== null">{{ money(g.deals_avg) }} <span class="text-xs text-muted-400">в сделках ({{ g.deals_n }})</span></div>
                                    <div v-if="g.catalogue !== null" class="text-xs text-muted-500">прайс {{ money(g.catalogue) }}</div>
                                    <div v-if="g.deals_avg === null && g.catalogue === null && g.our_quoted !== null">{{ money(g.our_quoted) }} <span class="text-xs text-muted-400">называли менеджеры</span></div>
                                    <span v-if="g.deals_avg === null && g.catalogue === null && g.our_quoted === null" class="text-muted-400">—</span>
                                </td>
                                <td class="py-2 pe-3">
                                    <template v-if="g.market_n">
                                        <div>{{ money(g.market_median) }} <span class="text-xs text-muted-400">обычно</span></div>
                                        <div v-if="g.market_n > 1" class="text-xs text-muted-500">{{ money(g.market_min) }} – {{ money(g.market_max) }}</div>
                                    </template>
                                    <span v-else class="text-muted-400">—</span>
                                    <div v-if="g.not_compared" class="text-xs text-muted-400">ещё {{ g.not_compared }} в другой валюте</div>
                                </td>
                                <td class="py-2 pe-3">{{ g.targets_n ? money(g.targets_median) : '—' }}</td>
                                <td class="py-2 pe-3">
                                    <span v-if="g.diff_pct !== null" class="whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium" :class="diffClass(g.diff_pct)">{{ diffText(g.diff_pct) }}</span>
                                    <span v-else class="text-muted-400">—</span>
                                </td>
                                <td class="py-2">{{ g.mentions }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </BaseCard>

            <!-- what the clients said -->
            <BaseCard class="flex flex-col gap-4 p-6">
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">Что говорят клиенты</BaseHeading>
                    <span class="text-sm text-muted-500 dark:text-muted-400">цены, партии, сроки, качество и оплата у других поставщиков — словами клиента</span>
                </div>
                <p v-if="!report.mentions.length" class="text-sm text-muted-500 dark:text-muted-400">Нет высказываний за этот период.</p>
                <ul class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700">
                    <li v-for="m in shownMentions" :key="m.id" class="flex flex-col gap-1 py-3 text-sm">
                        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="kindClass(m.kind)">{{ m.kind_label }}</span>
                            <span v-if="m.supplier || m.country" class="font-medium text-muted-800 dark:text-white">{{ [m.supplier, m.country].filter(Boolean).join(', ') }}</span>
                            <span v-if="productLine(m)" class="text-muted-600 dark:text-muted-300">{{ productLine(m) }}</span>
                            <span v-if="priceLine(m)" class="font-semibold text-muted-800 dark:text-white">{{ priceLine(m) }}</span>
                            <span v-if="m.diff_pct !== null" class="rounded-full px-2 py-0.5 text-xs font-medium" :class="diffClass(m.diff_pct)">{{ diffText(m.diff_pct, m.kind) }}</span>
                        </div>
                        <div v-if="terms(m)" class="text-muted-600 dark:text-muted-300">{{ terms(m) }}</div>
                        <p v-if="m.quote" class="break-words italic text-muted-700 dark:text-muted-200">«{{ m.quote }}»</p>
                        <div class="text-xs text-muted-500 dark:text-muted-400">
                            <NuxtLink :to="`/deals/${m.deal.id}`" class="text-primary-600 hover:underline dark:text-primary-300">№{{ m.deal.number ?? m.deal.id }} «{{ m.deal.label }}»</NuxtLink>
                            <template v-if="m.company"> · {{ m.company }}</template> · {{ day(m.at) }}<template v-if="m.agent"> · {{ m.agent }}</template>
                            <template v-if="m.our_price !== null"> · наша цена {{ money(m.our_price) }}<template v-if="m.our_product"> ({{ m.our_product.name }})</template></template>
                        </div>
                    </li>
                </ul>
                <BaseButton v-if="report.mentions.length > shownMentions.length" size="sm" class="self-start" @click="mentionsLimit += 30">
                    Показать ещё {{ Math.min(30, report.mentions.length - shownMentions.length) }}
                </BaseButton>
            </BaseCard>

            <!-- the signals of the conversations -->
            <BaseCard class="flex flex-col gap-4 p-6">
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">Сигналы из переписки</BaseHeading>
                    <span class="text-sm text-muted-500 dark:text-muted-400">«дорого», просьбы о скидке, конкуренты и цена, которую хочет клиент — по разбору ИИ</span>
                </div>
                <p v-if="!report.voices.length" class="text-sm text-muted-500 dark:text-muted-400">Нет сигналов за этот период.</p>
                <ul class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700">
                    <li v-for="v in shownVoices" :key="v.turn_id" class="flex flex-col gap-1 py-3 text-sm">
                        <div class="flex flex-wrap items-center gap-2">
                            <span
                                v-for="f in v.flags"
                                :key="f.flag"
                                class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
                            >{{ f.label }}</span>
                            <span v-if="v.target_price" class="text-muted-700 dark:text-muted-200">хочет цену: <span class="font-semibold">{{ v.target_price }}</span></span>
                            <span v-if="v.product" class="text-muted-500 dark:text-muted-400">{{ v.product }}</span>
                        </div>
                        <p v-if="v.quote" class="break-words italic text-muted-700 dark:text-muted-200">«{{ v.quote }}»</p>
                        <div class="text-xs text-muted-500 dark:text-muted-400">
                            <NuxtLink :to="`/deals/${v.deal.id}`" class="text-primary-600 hover:underline dark:text-primary-300">№{{ v.deal.number ?? v.deal.id }} «{{ v.deal.label }}»</NuxtLink>
                            · {{ day(v.at) }}
                        </div>
                    </li>
                </ul>
                <BaseButton v-if="report.voices.length > shownVoices.length" size="sm" class="self-start" @click="voicesLimit += 30">
                    Показать ещё {{ Math.min(30, report.voices.length - shownVoices.length) }}
                </BaseButton>
            </BaseCard>

            <p class="text-xs text-muted-400">
                Данные — из переписки сделок, которые вам видны: ИИ выписывает слова клиентов о ценах и предложениях конкурентов. Интернет не используется. Сверяйтесь с перепиской по ссылке на сделку.
            </p>
        </template>
    </div>
</template>

<script lang="ts" setup>
/**
 * «Рынок» (parisahon-api/src/ai-insights/market.service.ts, GET /ai/market): what clients say about the market in
 * the CRM's own conversations — the prices, MOQ, delivery, quality and payment terms of other suppliers with the
 * client's words, the prices clients want, «дорого» / «скидка» / «конкурент» — against our prices (the price
 * list, the deals). Filters: period, product, country. «Сводка ИИ» on demand (POST /ai/market/summary, cached
 * for the same data). Only the deals the user may see.
 */
import moment from 'moment';
import PeriodPicker from '~/components/analytics/PeriodPicker.vue';
import { promiseResult } from '~/utils/result';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Рынок',
});

useHead({
    title: 'Рынок',
});

type MarketMention = {
    id: number;
    at: string;
    kind: 'competitor' | 'client_target' | 'our';
    kind_label: string;
    deal: { id: number; number: number | null; label: string };
    company: string | null;
    agent: string | null;
    supplier: string | null;
    country: string | null;
    product: string | null;
    size: string | null;
    grammage: string | null;
    price: number | null;
    currency: string | null;
    unit: string | null;
    price_text: string | null;
    price_ours: number | null;
    moq: string | null;
    delivery: string | null;
    quality: string | null;
    payment: string | null;
    quote: string | null;
    our_product: { id: number; name: string; unit: string | null } | null;
    our_price: number | null;
    diff_pct: number | null;
};

type MarketGroup = {
    key: string;
    product_id: number | null;
    name: string;
    unit: string | null;
    catalogue: number | null;
    deals_avg: number | null;
    deals_n: number;
    our_quoted: number | null;
    market_n: number;
    market_min: number | null;
    market_median: number | null;
    market_max: number | null;
    targets_n: number;
    targets_median: number | null;
    diff_pct: number | null;
    mentions: number;
    not_compared: number;
    suppliers: string[];
    countries: string[];
};

type MarketVoice = {
    turn_id: number;
    at: string;
    deal: { id: number; number: number | null; label: string };
    flags: { flag: string; label: string }[];
    target_price: string | null;
    product: string | null;
    quote: string | null;
};

type MarketSummaryState = {
    status: string;
    fresh: boolean;
    cached?: boolean;
    made_at: string | null;
    data: { lines: string[]; dearer: { product: string; note: string }[]; cheaper: { product: string; note: string }[]; said: string[] } | null;
    error: string | null;
};

type MarketReport = {
    enabled: boolean;
    currency: string;
    compared_currencies: string[];
    counts: { mentions?: number; competitor?: number; client_target?: number; deals?: number; turns?: number; flags?: Record<string, number> };
    groups: MarketGroup[];
    mentions: MarketMention[];
    voices: MarketVoice[];
    options: { countries: string[]; products: { id: number; name: string }[] };
    summary: MarketSummaryState | null;
};

const service = useService('ai', { auth: true });
const toast = useToast('GlobalToast');
const { period, bounds } = useReportPeriod();

const productId = ref('');
const productText = ref('');
const country = ref('');
const report = ref<MarketReport | null>(null);
const loading = ref(false);
const loadError = ref('');
const summarizing = ref(false);
const summaryError = ref('');
const mentionsLimit = ref(30);
const voicesLimit = ref(30);
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollUntil = 0;

const query = computed(() => {
    const q: Record<string, any> = { ...bounds.value };
    if (productId.value) q.product_id = Number(productId.value);
    if (productText.value.trim()) q.product = productText.value.trim();
    if (country.value) q.country = country.value;
    return q;
});

const summary = computed(() => report.value?.summary ?? null);
const updating = computed(() => summarizing.value || summary.value?.status === 'queued' || summary.value?.status === 'running');
const hasData = computed(() => !!report.value && (report.value.groups.length > 0 || report.value.mentions.length > 0 || report.value.voices.length > 0));
const shownMentions = computed(() => (report.value?.mentions ?? []).slice(0, mentionsLimit.value));
const shownVoices = computed(() => (report.value?.voices ?? []).slice(0, voicesLimit.value));
const currencyLabel = computed(() => (report.value?.currency === 'UZS' ? 'сумах' : report.value?.currency ?? 'валюте CRM'));

// the lists keep the chosen value even when it is not in the period's data
const productOptions = computed(() => {
    const list = [...(report.value?.options.products ?? [])];
    if (productId.value && !list.some((p) => String(p.id) === productId.value)) list.unshift({ id: Number(productId.value), name: `Товар #${productId.value}` });
    return list;
});
const countryOptions = computed(() => {
    const list = [...(report.value?.options.countries ?? [])];
    if (country.value && !list.includes(country.value)) list.unshift(country.value);
    return list;
});

async function load() {
    loading.value = true;
    const result = await promiseResult(service.get('market', query.value).exec());
    loading.value = false;
    if (result.ok) {
        report.value = result.value as MarketReport;
        loadError.value = '';
    } else {
        loadError.value = result.error?.message || 'Не удалось загрузить данные';
    }
    schedulePoll();
}

function stopPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
}

/** a summary being made: the page asks again until it is ready (at most a few minutes) */
function schedulePoll() {
    stopPoll();
    const status = report.value?.summary?.status;
    if ((status === 'queued' || status === 'running') && Date.now() < pollUntil) pollTimer = setTimeout(load, 8000);
}

async function makeSummary() {
    if (summarizing.value) return;
    summarizing.value = true;
    summaryError.value = '';
    pollUntil = Date.now() + 5 * 60_000;
    const result = await promiseResult(service.post('market/summary', query.value).exec());
    summarizing.value = false;
    if (!result.ok) {
        toast.show({ message: result.error.message, type: 'error', timeout: 5000 });
        return;
    }
    const state = result.value as MarketSummaryState;
    if (state.status === 'empty' || state.status === 'failed' || state.status === 'skipped') summaryError.value = state.error || '';
    if (report.value) report.value.summary = state;
    await load();
}

let timer: ReturnType<typeof setTimeout> | null = null;
watch(query, () => {
    // the words of the product: after a pause in typing
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        mentionsLimit.value = 30;
        voicesLimit.value = 30;
        load();
    }, 400);
});

onMounted(load);
onUnmounted(() => {
    stopPoll();
    if (timer) clearTimeout(timer);
});

// a turn analysed, a reading ready: the API says 'changed' {ai: [...]} (merged: the report is reloaded at most every 15 s)
useLive((changes) => {
    if (changes.ai && !loading.value) load();
}, 15000);

function money(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function stamp(value: string | null | undefined): string {
    if (!value) return '';
    const m = moment(value);
    return m.isValid() ? (m.isSame(moment(), 'day') ? `сегодня ${m.format('HH:mm')}` : m.format('DD.MM.YYYY HH:mm')) : '';
}

function day(value: string | null | undefined): string {
    const m = value ? moment(value) : null;
    return m?.isValid() ? m.format('DD.MM.YYYY') : '';
}

/** the market against our price: «конкуренты дешевле на 12%» (we are dearer) or «дороже на 8%»; the client's own price too */
function diffText(diff: number, kind = 'competitor'): string {
    if (Math.abs(diff) < 1) return 'на уровне нашей цены';
    const pct = Math.abs(Math.round(diff));
    if (kind === 'client_target') return diff < 0 ? `хочет на ${pct}% ниже нашей` : `готов на ${pct}% выше нашей`;
    return diff < 0 ? `конкуренты дешевле на ${pct}%` : `конкуренты дороже на ${pct}%`;
}

function diffClass(diff: number): string {
    if (Math.abs(diff) < 1) return 'bg-muted-100 text-muted-700 dark:bg-muted-700 dark:text-muted-200';
    return diff < 0
        ? 'bg-danger-100 text-danger-700 dark:bg-danger-500/20 dark:text-danger-300'
        : 'bg-success-100 text-success-700 dark:bg-success-500/20 dark:text-success-300';
}

function kindClass(kind: string): string {
    if (kind === 'competitor') return 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200';
    if (kind === 'client_target') return 'bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-200';
    return 'bg-muted-100 text-muted-700 dark:bg-muted-700 dark:text-muted-200';
}

function productLine(m: MarketMention): string {
    return [m.product, m.size, m.grammage ? `${m.grammage} г/м²` : null].filter(Boolean).join(' ');
}

function priceLine(m: MarketMention): string {
    const written = m.price_text || (m.price !== null ? `${money(m.price)} ${m.currency ?? ''}`.trim() : '');
    if (!written) return '';
    const converted = m.price_ours !== null && m.currency && m.currency !== report.value?.currency ? ` (≈ ${money(m.price_ours)})` : '';
    return `${written}${m.unit && !m.price_text ? ` / ${m.unit}` : ''}${converted}`;
}

function terms(m: MarketMention): string {
    return [
        m.moq ? `партия от ${m.moq}` : null,
        m.delivery ? `срок ${m.delivery}` : null,
        m.payment ? `оплата: ${m.payment}` : null,
        m.quality ? `качество: ${m.quality}` : null,
    ]
        .filter(Boolean)
        .join(' · ');
}
</script>
