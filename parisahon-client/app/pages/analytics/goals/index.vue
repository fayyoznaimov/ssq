<script lang="ts" setup>
import moment from 'moment';
import BaseButton from '~/components/base/BaseButton.vue';
import Money from '~/components/common/Money.vue';
import type { ObjectiveResultStat } from '~/types/stats';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Цели'
});

useHead({
    title: 'Цели'
});

enum Period {
    Monthly = 'monthly',
    Quarterly = 'quarterly',
    Yearly = 'yearly'
}

// a plan is set per month, quarter and year: the fact is counted for that same month, quarter or year
// (before: by default for all time against the monthly plan — hundreds of percent)
const UNIT: Record<Period, moment.unitOfTime.StartOf> = {
    [Period.Monthly]: 'month',
    [Period.Quarterly]: 'quarter',
    [Period.Yearly]: 'year',
};

type GoalUser = ObjectiveResultStat['users'][number] & { deleted?: boolean };

const progressEls = ref<Record<string, HTMLProgressElement>>({});
const route = useRoute();
const period = computed<Period>(() => Object.values(Period).includes(route.query.period as Period) ? route.query.period as Period : Period.Monthly);
// any day of the month / quarter / year shown; today by default
const anchor = computed(() => {
    const at = moment(String(route.query.at ?? ''), 'YYYY-MM-DD', true);
    return at.isValid() ? at : moment();
});
const range = computed(() => {
    const unit = UNIT[period.value];
    return [anchor.value.clone().startOf(unit).format('YYYY-MM-DD'), anchor.value.clone().endOf(unit).format('YYYY-MM-DD')];
});
const periodLabel = computed(() => {
    const at = anchor.value.clone().locale('ru');
    if (period.value === Period.Quarterly) return `${at.quarter()} квартал ${at.year()}`;
    if (period.value === Period.Yearly) return `${at.year()} год`;
    const month = at.format('MMMM YYYY');
    return month.charAt(0).toUpperCase() + month.slice(1);
});
const isCurrent = computed(() => moment().isBetween(moment(range.value[0]), moment(range.value[1]).endOf('day'), undefined, '[]'));

const objectiveResultService = useService('analytics/objectives/results');
const {data: results, run: runResults} = useAsync<{groups: ObjectiveResultStat[]}>({groups: []});

function shift(step: number) {
    navigateTo({ path: '/analytics/goals', query: { ...route.query, at: anchor.value.clone().add(step, UNIT[period.value]).format('YYYY-MM-DD') } });
}

function toToday() {
    const { at, ...query } = route.query;
    navigateTo({ path: '/analytics/goals', query });
}

function fetchStats() {
    runResults(objectiveResultService.find({
        from_date: range.value[0],
        till_date: range.value[1],
    }).exec());
}

/** The plan of a group or a person for the chosen kind of period (0 when it is not set). */
function goalOf(objectives: { monthly?: number; quarterly?: number; yearly?: number } | null | undefined) {
    return Number(objectives?.[period.value] ?? 0) || 0;
}

const total = computed(() => {
    let budget = 0;
    let goal = 0;
    for (const group of results.value.groups) {
        // sales of a group without a plan (also "Вне групп") are still sales
        budget += group.total_budget;
        if (group.objectives == null) continue;
        goal += goalOf(group.objectives);
    }

    return {budget, goal}
});

function measureText(text: string) {
    let width = 0;
    const span = document.createElement('span');
    span.style.padding = '0 0.4rem';
    span.textContent = text;
    document.body.appendChild(span);
    width = span.offsetWidth;
    document.body.removeChild(span);

    return width;
}

function calculateColor(budget: number, goal: number) {
    const progress = budget / goal * 100;
    const formatted = formatMoney(budget, 0, {spaceBetweenAmountAndSymbol: ' ', symbolOnLeft: false})

    return JSON.stringify({progress, formatted, formattedMeasured: measureText(formatted)});
}

watch(range, fetchStats);
onMounted(fetchStats);
</script>
<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex flex-wrap items-center gap-4">
                <h1 class="text-xl whitespace-nowrap">Цели по сделкам</h1>
                <div class="flex items-center gap-2">
                    <BaseButtonIcon size="sm" rounded="md" aria-label="Раньше" @click="shift(-1)">
                        <Icon name="ph:caret-left" class="size-4" />
                    </BaseButtonIcon>
                    <span class="min-w-36 text-center font-medium text-muted-800 dark:text-muted-100">{{ periodLabel }}</span>
                    <BaseButtonIcon size="sm" rounded="md" aria-label="Позже" @click="shift(1)">
                        <Icon name="ph:caret-right" class="size-4" />
                    </BaseButtonIcon>
                    <BaseButton v-if="!isCurrent" size="sm" @click="toToday">Сейчас</BaseButton>
                </div>
            </div>
            <BaseButton to="/analytics/goals/settings">
                <Icon name="ph:gear" class="size-5 me-2"/>
                Настройка целей
            </BaseButton>
        </div>
        <BaseButtonGroup>
            <BaseButton color="default" :to="{path: '/analytics/goals', query: {...route.query, period: Period.Monthly}}"
                :class="period === Period.Monthly ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                <span>По месяцам</span>
            </BaseButton>
            <BaseButton color="default" :to="{path: '/analytics/goals', query: {...route.query, period: Period.Quarterly}}"
                :class="period === Period.Quarterly ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                <span>По кварталам</span>
            </BaseButton>
            <BaseButton color="default" :to="{path: '/analytics/goals', query: {...route.query, period: Period.Yearly}}"
                :class="period === Period.Yearly ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                <span>По годам</span>
            </BaseButton>
        </BaseButtonGroup>
        <p class="text-sm text-muted-500 -mt-4">
            Факт — бюджет сделок на этапе успеха, закрытых в этом периоде ({{ range[0] }} — {{ range[1] }}); план — {{ period === Period.Monthly ? 'месячный' : period === Period.Quarterly ? 'квартальный' : 'годовой' }}.
        </p>
        <div class="max-w-5xl">
            <div class="text-muted-700 flex gap-3 items-center dark:text-muted-200">
                <span class="max-w-40 w-full">Всего</span>
                <progress
                    class="max-w-2xl w-full progress"
                    :value="total.budget"
                    :max="total.goal"
                    :data-budget="formatMoney(total.budget, 0, {spaceBetweenAmountAndSymbol: ' ', symbolOnLeft: false})"
                >
                </progress>
                <Money :value="total.goal" />
            </div>
            <ul v-if="results.groups.length" class="flex flex-col gap-8 mt-6">
                <li v-for="group in results.groups" :key="group.id ?? 'outside'">
                    <div class="text-muted-700 flex gap-3 items-center dark:text-muted-200">
                        <span class="font-semibold text-lg max-w-40 w-full">{{ group.name }}</span>
                        <progress
                            class="max-w-2xl w-full progress"
                            :data-budget="formatMoney(group.total_budget, 0, {spaceBetweenAmountAndSymbol: ' ', symbolOnLeft: false})"
                            :value="group.total_budget"
                            :max="goalOf(group.objectives)"
                            :ref="(el) => progressEls[group.id] = el as HTMLProgressElement"
                        >
                        </progress>
                        <Money :value="goalOf(group.objectives)" />
                    </div>
                    <ul class="flex flex-col gap-4 mt-4">
                        <li v-for="user in (group.users as GoalUser[])" :key="user.id" class="text-muted-700 flex gap-3 items-center dark:text-muted-200">
                            <span class="max-w-40 w-full">
                                {{ user.username }}
                                <span v-if="user.deleted" class="text-muted-400 text-xs">(удалён)</span>
                            </span>
                            <progress
                                class="max-w-2xl w-full progress"
                                :value="user.total_budget"
                                :max="goalOf(user.objectives)"
                                :data-budget="formatMoney(user.total_budget, 0, {spaceBetweenAmountAndSymbol: ' ', symbolOnLeft: false})"
                                :ref="(el) => progressEls[group.id] = el as HTMLProgressElement"
                            >
                            </progress>
                            <Money :value="goalOf(user.objectives)" />
                        </li>
                    </ul>
                </li>
            </ul>
            <p v-else class="text-amber-500 text-sm mt-2">
                <Icon name="ph:warning" />
                Недостаточно данных для отображения
            </p>
        </div>
    </div>
</template>

<style scoped>

.progress {
    --color: white;
    @apply relative;
}

.progress[value]::-webkit-progress-bar {
    @apply bg-muted-200 rounded-sm h-6 dark:bg-muted-800;
}

.progress[value]::-webkit-progress-value {
    @apply bg-primary-300 rounded-sm h-6;
}

.progress:before {
    content: attr(data-budget);
    position: absolute;
    padding: 0 0.4rem;
    top: 50%;
    transform: translateY(-30%);
    font-size: 0.875rem;
    color: var(--color);
}

</style>
