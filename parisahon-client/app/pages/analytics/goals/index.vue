<script lang="ts" setup>
import moment from 'moment';
import BaseButton from '~/components/base/BaseButton.vue';
import { formatDay, formatSum } from '~/utils/format';
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

/** «4 200 000 ₽ из 6 000 000 ₽ · 70 %»: the fact, the plan and how much of it is done (null — no plan) */
function progressOf(budget: number, goal: number) {
    const fact = Number(budget) || 0;
    const plan = Number(goal) || 0;
    const percent = plan > 0 ? Math.round((fact / plan) * 100) : null;
    // the bar: red below half, amber below the plan, green at the plan and above
    const color = percent === null ? 'bg-muted-300 dark:bg-muted-600'
        : percent >= 100 ? 'bg-success-500' : percent >= 50 ? 'bg-amber-400' : 'bg-rose-400';
    return { fact, plan, percent, width: percent === null ? 0 : Math.min(100, percent), color };
}

watch(range, fetchStats);
onMounted(fetchStats);
</script>
<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
            <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
                <h1 class="text-xl">Цели по сделкам</h1>
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
            <BaseButton to="/analytics/goals/settings" class="self-start whitespace-nowrap">
                <Icon name="ph:gear" class="size-5 me-2"/>
                Настройка целей
            </BaseButton>
        </div>
        <div class="overflow-x-auto max-w-full">
            <BaseButtonGroup class="whitespace-nowrap">
                <BaseButton color="default" :to="{path: '/analytics/goals', query: {...route.query, period: Period.Monthly}}"
                    :class="period === Period.Monthly ? 'toggle-selected' : ''">
                    <span>По месяцам</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/analytics/goals', query: {...route.query, period: Period.Quarterly}}"
                    :class="period === Period.Quarterly ? 'toggle-selected' : ''">
                    <span>По кварталам</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/analytics/goals', query: {...route.query, period: Period.Yearly}}"
                    :class="period === Period.Yearly ? 'toggle-selected' : ''">
                    <span>По годам</span>
                </BaseButton>
            </BaseButtonGroup>
        </div>
        <p class="text-sm text-muted-500 -mt-2">
            Факт — бюджет сделок на этапе успеха, закрытых в этом периоде ({{ formatDay(range[0]) }} — {{ formatDay(range[1]) }});
            план — {{ period === Period.Monthly ? 'месячный' : period === Period.Quarterly ? 'квартальный' : 'годовой' }}.
        </p>
        <div class="max-w-4xl flex flex-col gap-6">
            <!-- the total -->
            <div class="flex flex-col gap-1.5">
                <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span class="font-semibold text-lg text-muted-800 dark:text-white">Всего</span>
                    <span class="text-sm text-muted-700 dark:text-muted-200">
                        <template v-if="progressOf(total.budget, total.goal).plan">
                            <b>{{ formatSum(total.budget) }}</b> из {{ formatSum(total.goal) }} · {{ progressOf(total.budget, total.goal).percent }}%
                        </template>
                        <template v-else><b>{{ formatSum(total.budget) }}</b> · цель не задана</template>
                    </span>
                </div>
                <div class="h-3 rounded-full bg-muted-200 dark:bg-muted-800 overflow-hidden">
                    <div class="h-full rounded-full transition-[width] duration-500" :class="progressOf(total.budget, total.goal).color" :style="{ width: progressOf(total.budget, total.goal).width + '%' }"></div>
                </div>
            </div>
            <p v-if="!total.goal" class="text-sm text-amber-600">
                <Icon name="ph:info" class="me-1" />
                Цели на этот период не заданы —
                <NuxtLink to="/analytics/goals/settings" class="underline">задать в «Настройке целей»</NuxtLink>.
            </p>

            <ul v-if="results.groups.length" class="flex flex-col gap-8">
                <li v-for="group in results.groups" :key="group.id ?? 'outside'" class="flex flex-col gap-3">
                    <div class="flex flex-col gap-1.5">
                        <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                            <span class="font-semibold text-muted-800 dark:text-white">{{ group.name }}</span>
                            <span class="text-sm text-muted-700 dark:text-muted-200">
                                <template v-if="progressOf(group.total_budget, goalOf(group.objectives)).plan">
                                    <b>{{ formatSum(group.total_budget) }}</b> из {{ formatSum(goalOf(group.objectives)) }} · {{ progressOf(group.total_budget, goalOf(group.objectives)).percent }}%
                                </template>
                                <template v-else><b>{{ formatSum(group.total_budget) }}</b> · цель не задана</template>
                            </span>
                        </div>
                        <div class="h-3 rounded-full bg-muted-200 dark:bg-muted-800 overflow-hidden">
                            <div class="h-full rounded-full transition-[width] duration-500" :class="progressOf(group.total_budget, goalOf(group.objectives)).color" :style="{ width: progressOf(group.total_budget, goalOf(group.objectives)).width + '%' }"></div>
                        </div>
                    </div>
                    <ul class="flex flex-col gap-3 ps-3 border-s-2 border-muted-200 dark:border-muted-700">
                        <li v-for="user in (group.users as GoalUser[])" :key="user.id" class="flex flex-col gap-1">
                            <div class="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                                <span class="text-muted-700 dark:text-muted-200">
                                    {{ user.username }}
                                    <span v-if="user.deleted" class="text-muted-400 text-xs">(удалён)</span>
                                </span>
                                <span class="text-muted-600 dark:text-muted-300">
                                    <template v-if="progressOf(user.total_budget, goalOf(user.objectives)).plan">
                                        {{ formatSum(user.total_budget) }} из {{ formatSum(goalOf(user.objectives)) }} · {{ progressOf(user.total_budget, goalOf(user.objectives)).percent }}%
                                    </template>
                                    <template v-else>{{ formatSum(user.total_budget) }} · цель не задана</template>
                                </span>
                            </div>
                            <div class="h-2 rounded-full bg-muted-200 dark:bg-muted-800 overflow-hidden">
                                <div class="h-full rounded-full transition-[width] duration-500" :class="progressOf(user.total_budget, goalOf(user.objectives)).color" :style="{ width: progressOf(user.total_budget, goalOf(user.objectives)).width + '%' }"></div>
                            </div>
                        </li>
                    </ul>
                </li>
            </ul>
            <p v-else class="text-amber-500 text-sm">
                <Icon name="ph:warning" />
                Недостаточно данных для отображения
            </p>
        </div>
    </div>
</template>
