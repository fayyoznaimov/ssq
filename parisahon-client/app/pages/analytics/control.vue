<script setup lang="ts">
import DatePicker from '@vuepic/vue-datepicker';
import moment from 'moment';
import BaseTable from '~/components/common/BaseTable.vue';
import { type Column } from '~/components/common/types';
import AiInboundSection from '~/components/ai-insights/InboundSection.vue';
import AiQualitySection from '~/components/ai-insights/QualitySection.vue';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Контроль менеджеров'
});

useHead({
    title: 'Контроль менеджеров'
});

interface ControlAgent {
    id: number;
    name: string;
    leads: number;
    calls: number;
    outgoing_calls: number;
    call_minutes: number;
    turns: number;
    answered: number;
    late: number;
    unanswered: number;
    first_response_median_sec: number | null;
    response_median_sec: number | null;
    response_p90_sec: number | null;
    in_sla_share: number | null;
}

interface ControlWaiting {
    deal_id: number;
    deal_label: string;
    contact_name: string | null;
    channel: string;
    text: string | null;
    agent_name: string | null;
    asked_at: string;
    waiting_seconds: number;
}

interface ControlReport {
    norm: { sla_minutes: number; waiting_hours: number; work_hours: string; work_days: string };
    summary: {
        new_deals: number;
        by_channel: Record<string, number>;
        first_response_median_sec: number | null;
        response_median_sec: number | null;
        response_p90_sec: number | null;
        in_sla_share: number | null;
        late: number;
        waiting_now: number;
        calls: number;
    };
    agents: ControlAgent[];
    waiting: ControlWaiting[];
}

const colorMode = useColorMode();
const controlService = useService('/analytics/control', { auth: true });
const { data: report, isLoading, run } = useAsync<ControlReport | null>(null);

const dateRange = ref([moment().startOf('month').format('YYYY-MM-DD'), moment().format('YYYY-MM-DD')]);
const sla = ref(15);
const SLA_OPTIONS = [5, 15, 30, 60];

const presetDates = ref([
    { label: 'За сегодня', value: [moment().startOf('day'), moment().startOf('day')] },
    { label: 'За вчера', value: [moment().subtract(1, 'day').startOf('day'), moment().subtract(1, 'day').startOf('day')] },
    { label: 'За эту неделю', value: [moment().startOf('week'), moment().endOf('week')] },
    { label: 'За этот месяц', value: [moment().startOf('month'), moment().endOf('month')] },
    { label: 'За прошлый месяц', value: [moment().subtract(1, 'month').startOf('month'), moment().subtract(1, 'month').endOf('month')] },
    { label: 'За этот год', value: [moment().startOf('year'), moment().endOf('year')] },
]);

function formatRange(dates: Date[]) {
    const fromStr = moment(dates[0]).format('YYYY-MM-DD');
    const toStr = moment(dates[1]).format('YYYY-MM-DD');
    for (const preset of presetDates.value) {
        if (preset.value[0].format('YYYY-MM-DD') === fromStr && preset.value[1].format('YYYY-MM-DD') === toStr) {
            return preset.label;
        }
    }
    return `${fromStr} - ${toStr}`;
}

function fetchReport() {
    run(controlService.find({
        from_date: dateRange.value[0],
        till_date: dateRange.value[1],
        sla_minutes: sla.value,
    }).exec());
}

watch(() => [dateRange.value, sla.value], fetchReport);
onMounted(fetchReport);

/** Seconds of working time in words: «9 мин», «1 ч 40 мин», «2 дн 3 ч». */
function duration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined) return '—';
    if (seconds < 60) return seconds === 0 ? 'сразу' : `${seconds} с`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} мин`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
    return `${Math.floor(hours / 24)} дн ${hours % 24} ч`;
}

const CHANNELS: Record<string, string> = {
    whatsapp: 'WhatsApp',
    telegram: 'Telegram',
    email: 'Почта',
    sms: 'SMS',
    calls: 'Звонки',
    other: 'Другое',
};

const channelLine = computed(() => {
    const entries = Object.entries(report.value?.summary.by_channel ?? {});
    if (entries.length === 0) return 'нет новых заявок';
    return entries
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${CHANNELS[key] ?? key} ${count}`)
        .join(' · ');
});

const rows = computed(() => (report.value?.agents ?? []).map((agent) => ({
    ...agent,
    first_response: duration(agent.first_response_median_sec),
    response: duration(agent.response_median_sec),
    response_p90: duration(agent.response_p90_sec),
    in_sla: agent.in_sla_share === null ? '—' : `${agent.in_sla_share}%`,
    calls_line: agent.calls ? `${agent.calls} (${agent.call_minutes} мин)` : '0',
})));

const columns = ref<Column[]>([
    { label: 'Менеджер', name: 'name', resizable: true },
    { label: 'Новых сделок', name: 'leads', resizable: true },
    { label: 'Звонков', name: 'calls_line', resizable: true },
    { label: 'Обращений', name: 'turns', resizable: true },
    { label: 'Первый ответ', name: 'first_response', resizable: true },
    { label: 'Ответ обычно', name: 'response', resizable: true },
    { label: 'Худшие 10%', name: 'response_p90', resizable: true },
    { label: 'В норматив', name: 'in_sla', resizable: true },
    { label: 'Не ответил вовремя', name: 'late', resizable: true },
    { label: 'Без ответа', name: 'unanswered', resizable: true },
]);

const lateWarning = computed(() => (report.value?.summary.in_sla_share ?? 100) < 80);
</script>

<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-wrap items-center gap-4">
            <h1 class="text-xl">Контроль менеджеров</h1>
            <div class="max-w-xs w-full shrink-0">
                <DatePicker
                    v-model="dateRange"
                    :format="formatRange"
                    range
                    text-input
                    vertical
                    :preset-dates="presetDates"
                    auto-apply
                    :enable-time-picker="false"
                    model-type="yyyy-MM-dd"
                    :teleport="true"
                    :dark="colorMode.value === 'dark'"
                >
                    <template #dp-input="{ onInput, value, onBlur, onPaste }">
                        <BaseInput :value="value" @input="onInput" @blur="onBlur" @paste="onPaste" placeholder="Период" />
                    </template>
                </DatePicker>
            </div>
            <BaseButtonGroup>
                <BaseButton
                    v-for="minutes of SLA_OPTIONS"
                    :key="minutes"
                    color="default"
                    :class="sla === minutes ? 'toggle-selected' : ''"
                    @click="sla = minutes"
                >
                    <span>Норматив {{ minutes }} мин</span>
                </BaseButton>
            </BaseButtonGroup>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <BaseCard class="p-6 flex flex-col gap-2">
                <span class="text-xs uppercase font-semibold text-muted-500 dark:text-muted-300">Новых сделок</span>
                <span class="text-3xl font-semibold text-muted-800 dark:text-white">{{ report?.summary.new_deals ?? '—' }}</span>
                <span class="text-sm text-muted-500 dark:text-muted-400">{{ channelLine }}</span>
            </BaseCard>
            <BaseCard class="p-6 flex flex-col gap-2">
                <span class="text-xs uppercase font-semibold text-muted-500 dark:text-muted-300">Первый ответ, обычно</span>
                <span class="text-3xl font-semibold text-muted-800 dark:text-white">{{ duration(report?.summary.first_response_median_sec) }}</span>
                <span class="text-sm text-muted-500 dark:text-muted-400">в худших 10% — {{ duration(report?.summary.response_p90_sec) }}</span>
            </BaseCard>
            <BaseCard class="p-6 flex flex-col gap-2">
                <span class="text-xs uppercase font-semibold text-muted-500 dark:text-muted-300">Ответов в норматив</span>
                <span
                    class="text-3xl font-semibold"
                    :class="lateWarning ? 'text-orange-500' : 'text-muted-800 dark:text-white'"
                >
                    {{ report?.summary.in_sla_share === null || report?.summary.in_sla_share === undefined ? '—' : `${report.summary.in_sla_share}%` }}
                </span>
                <span class="text-sm text-muted-500 dark:text-muted-400">{{ report?.summary.late ?? 0 }} раз ответили позже {{ sla }} мин</span>
            </BaseCard>
            <BaseCard
                class="p-6 flex flex-col gap-2"
                :class="(report?.summary.waiting_now ?? 0) > 0 ? '!border-orange-400' : ''"
            >
                <span class="text-xs uppercase font-semibold text-muted-500 dark:text-muted-300">Ждут ответа сейчас</span>
                <span
                    class="text-3xl font-semibold"
                    :class="(report?.summary.waiting_now ?? 0) > 0 ? 'text-orange-500' : 'text-muted-800 dark:text-white'"
                >
                    {{ report?.summary.waiting_now ?? '—' }}
                </span>
                <span class="text-sm text-muted-500 dark:text-muted-400">клиент написал последним дольше {{ report?.norm.waiting_hours ?? 2 }} ч назад, за любой период</span>
            </BaseCard>
        </div>

        <BaseCard class="p-6 flex flex-col gap-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
                <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">
                    По менеджерам
                </BaseHeading>
                <span class="text-sm text-muted-500 dark:text-muted-400">
                    Время считается в рабочие часы: {{ report?.norm.work_hours ?? '09:00-18:00' }}.
                    Ответ — сообщение, письмо или исходящий звонок клиенту
                </span>
            </div>
            <div class="relative overflow-x-auto">
                <BaseTable
                    :columns="columns"
                    :data="rows"
                    :loading="isLoading"
                    class="flex-auto"
                    id="control-agents"
                />
            </div>
        </BaseCard>

        <BaseCard class="p-6 flex flex-col gap-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
                <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">
                    Клиенты ждут ответа
                </BaseHeading>
                <span class="text-sm text-muted-500 dark:text-muted-400">сейчас, не зависит от выбранного периода</span>
            </div>
            <div v-if="!isLoading && (report?.waiting.length ?? 0) === 0" class="text-sm text-muted-500 dark:text-muted-400">
                Все клиенты получили ответ.
            </div>
            <ul class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700">
                <li
                    v-for="item of report?.waiting ?? []"
                    :key="`${item.deal_id}-${item.asked_at}`"
                    class="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                    <div class="flex min-w-0 flex-col gap-1">
                        <NuxtLink :to="`/deals/${item.deal_id}`" class="font-medium text-primary-600 hover:underline dark:text-primary-200">
                            {{ item.contact_name || item.deal_label }} · {{ CHANNELS[item.channel] ?? item.channel }}
                        </NuxtLink>
                        <span class="truncate text-sm text-muted-500 dark:text-muted-400">
                            «{{ item.text || 'вложение' }}» · {{ item.agent_name || 'без ответственного' }}
                        </span>
                    </div>
                    <span class="whitespace-nowrap font-semibold text-orange-500">{{ duration(item.waiting_seconds) }}</span>
                </li>
            </ul>
        </BaseCard>

        <!-- the AI (src/ai-insights): the first messages of new contacts, the nightly review of the dialogs; hidden while off -->
        <AiInboundSection :from="dateRange[0]" :till="dateRange[1]" />
        <AiQualitySection :from="dateRange[0]" :till="dateRange[1]" />
    </div>
</template>
