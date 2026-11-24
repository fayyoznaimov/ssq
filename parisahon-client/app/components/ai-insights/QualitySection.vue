<template>
    <BaseCard v-if="data && (data.enabled || data.total.dialogs > 0)" class="flex flex-col gap-4 p-6">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
                <BaseHeading as="h3" size="md" weight="semibold" lead="tight" class="text-muted-800 dark:text-white">
                    Качество диалогов
                </BaseHeading>
                <span class="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700 dark:bg-primary-500/20 dark:text-primary-200">
                    рекомендации ИИ · на оценки не влияют
                </span>
            </div>
            <span class="text-sm text-muted-500 dark:text-muted-400">
                Ночью ИИ разбирает переписку каждого дня по чек-листу: приветствие, потребность, ответы на вопросы, вежливость, следующий шаг, грамотность
            </span>
        </div>

        <p v-if="!data.total.dialogs" class="text-sm text-muted-500 dark:text-muted-400">
            За период диалоги ещё не разобраны<template v-if="data.queued"> (в очереди: {{ data.queued }})</template>.
        </p>
        <template v-else>
            <p class="text-sm text-muted-600 dark:text-muted-300">
                Разобрано диалогов: <span class="font-semibold">{{ data.total.dialogs }}</span><template v-if="data.total.score !== null">, в среднем <span class="font-semibold">{{ data.total.score }}%</span></template>
            </p>
            <div class="overflow-x-auto">
                <table class="w-full min-w-[760px] text-left text-sm">
                    <thead class="text-xs uppercase text-muted-500 dark:text-muted-400">
                        <tr class="border-b border-muted-200 dark:border-muted-700">
                            <th class="py-2 pe-3 font-semibold">Менеджер</th>
                            <th class="py-2 pe-3 font-semibold">Диалогов</th>
                            <th class="py-2 pe-3 font-semibold">Оценка</th>
                            <th v-for="c of data.criteria" :key="c.key" class="py-2 pe-3 font-semibold">{{ c.label }}</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-muted-200 dark:divide-muted-700">
                        <tr v-for="a of data.agents" :key="a.id">
                            <td class="py-2 pe-3 font-medium text-muted-800 dark:text-white">{{ a.name }}</td>
                            <td class="py-2 pe-3">{{ a.dialogs }}</td>
                            <td class="py-2 pe-3 font-semibold" :class="scoreClass(a.score)">{{ a.score === null ? '—' : a.score + '%' }}</td>
                            <td v-for="c of data.criteria" :key="c.key" class="py-2 pe-3" :class="scoreClass(a.criteria[c.key])">
                                {{ a.criteria[c.key] === null || a.criteria[c.key] === undefined ? '—' : a.criteria[c.key] + '%' }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div class="flex flex-col gap-3">
                <details v-for="a of agentsWithMistakes" :key="'m' + a.id" class="rounded-lg border border-muted-200 p-3 dark:border-muted-700">
                    <summary class="cursor-pointer select-none text-sm font-medium text-muted-800 dark:text-white">
                        {{ a.name }}: как сказать лучше<template v-if="a.weakest"> · слабее всего «{{ a.weakest.label }}»</template>
                    </summary>
                    <ul class="mt-2 flex flex-col gap-3 text-sm">
                        <li v-for="(m, i) of a.mistakes" :key="i" class="flex flex-col gap-0.5">
                            <span class="text-xs font-semibold uppercase text-muted-500">{{ m.criterion_label }}</span>
                            <span class="break-words text-muted-700 dark:text-muted-200">Написал: <span class="italic">«{{ m.quote }}»</span></span>
                            <span class="break-words text-success-700 dark:text-success-300">Лучше: «{{ m.better }}»</span>
                            <span class="text-xs text-muted-400">
                                <NuxtLink :to="`/deals/${m.deal.id}`" class="text-primary-600 hover:underline dark:text-primary-300">№{{ m.deal.number ?? m.deal.id }} «{{ m.deal.label }}»</NuxtLink>
                                · {{ day(m.day) }}
                            </span>
                        </li>
                    </ul>
                </details>
            </div>
        </template>
        <p class="text-xs text-muted-400">{{ data.note }}. Подсказки раз в неделю приходят менеджерам в бот CRM.</p>
    </BaseCard>
</template>

<script lang="ts" setup>
/**
 * «Качество диалогов» of the control page (parisahon-api/src/ai-insights/supervisor.service.ts, GET /ai/quality):
 * the nightly reviews of the managers' conversations of the period — per employee the dialogs, the average score,
 * each criterion of the checklist and the main mistakes with «как сказать лучше». Advisory: not part of any rating.
 * Nothing is shown while «ИИ-супервайзер» is off and there are no reviews.
 */
import moment from 'moment';
import { promiseResult } from '~/utils/result';

const props = defineProps<{ from?: string | null; till?: string | null }>();

type QualityMistake = {
    deal: { id: number; number: number | null; label: string };
    day: string;
    criterion: string;
    criterion_label: string;
    quote: string;
    better: string;
};
type QualityAgent = {
    id: number;
    name: string;
    dialogs: number;
    score: number | null;
    criteria: Record<string, number | null>;
    weakest: { key: string; label: string; value: number } | null;
    mistakes: QualityMistake[];
};
type Quality = {
    enabled: boolean;
    note: string;
    criteria: { key: string; label: string }[];
    total: { dialogs: number; score: number | null };
    agents: QualityAgent[];
    queued: number;
};

const service = useService('ai', { auth: true });
const data = ref<Quality | null>(null);

const agentsWithMistakes = computed(() => (data.value?.agents ?? []).filter((a) => a.mistakes.length));

async function load() {
    const query: Record<string, any> = {};
    if (props.from) query.from_date = props.from;
    if (props.till) query.till_date = props.till;
    const result = await promiseResult(service.get('quality', query).exec());
    if (result.ok) data.value = result.value as Quality;
}

function scoreClass(value: number | null | undefined): string {
    if (value === null || value === undefined) return 'text-muted-400';
    if (value < 50) return 'text-danger-600 dark:text-danger-400';
    if (value < 75) return 'text-orange-500';
    return 'text-muted-800 dark:text-white';
}

function day(value: string): string {
    const m = moment(value);
    return m.isValid() ? m.format('DD.MM.YYYY') : value;
}

watch(() => [props.from, props.till], load);
onMounted(load);
</script>
