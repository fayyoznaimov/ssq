<script lang="ts" setup>
import BaseButton from '~/components/base/BaseButton.vue';
import Money from '~/components/common/Money.vue';
import type { DealStats } from '~/types/stats';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Цели'
});

useHead({
    title: 'Цели'
});

enum Status {
    All = 1,
    Active = 2,
    Closed = 3
}

enum By {
    Budget = 1,
    Count = 2,
}

const route = useRoute();
const status = ref(route.query.status || Status.Active);
const by = ref(route.query.by || By.Budget);
const analyticsService = useService('analytics/deals', {auth: true});
const {data: deals, run: runDeals} = useAsync<DealStats>({
    stages: [],
    average_deal_duration_in_minutes: "0",
    total_deal_count: "0",
});

function fetchStats() {
    const query: Record<string, any> = {}
    if (status.value === Status.Active) {
        query.is_active = true
    }
    if (status.value === Status.Closed) {
        query.is_active = false;
    }
    runDeals(analyticsService.find(query).exec())
}

const sortedStages = computed(() => deals.value.stages.sort((a, b) => a.order - b.order));
const totals = computed(() => {
    let budget = 0;
    let duration = 0;
    for (const stage of sortedStages.value) {
        budget += Number(stage.total_deal_budget);
        duration += Number(stage.average_time_in_stage);
    }

    return {budget, duration}
});

function formatTime(minutes: string) {
    const n = Number(minutes);
    if (n >= 1440) return `${Math.round(n / 1440)}д.`
    else return `${Math.round(n / 60)}ч.`
}

function getPercent(stage: DealStats['stages'][0]) {
    let value = 0;
    if (by.value === By.Budget) value = Math.floor(Number(stage.total_deal_budget) / totals.value.budget * 100);
    if (by.value === By.Count) value =  Math.floor(Number(stage.deal_count) / Number(deals.value.total_deal_count) * 100);

    return isNaN(value) ? 0 : value;
}

const durationRangeMap = computed(() => {
    const range: Record<number, [number, number]> = {}
    let prevTime = 0;
    for (let i = 0, len = sortedStages.value.length; i < len; i++) {
        const currentStage = sortedStages.value[i];
        const prevStage = sortedStages.value[i - 1];
        let currentTime = Math.floor(Number(currentStage.average_time_in_stage || 0) / 1440);
        if (!prevStage) {
            range[currentStage.id] = [0, currentTime];
            continue;
        }
        if (prevStage.average_time_in_stage) prevTime = Math.floor(Number(prevStage.average_time_in_stage) / 1440);
        range[currentStage.id] = [prevTime, currentTime]
    }

    return range;
});

watchEffect(() => {
    status.value = Number(route.query.status) || Status.Active;
});

watchEffect(() => {
    by.value = Number(route.query.by) || By.Budget;
});

watch(status, fetchStats);
onMounted(fetchStats);
</script>
<template>
    <div class="flex flex-col gap-8">
        <h1 class="text-xl whitespace-nowrap">Анализ продаж</h1>
        <div class="flex justify-between">
            <BaseButtonGroup>
                <BaseButton color="default" :to="{path: '/analytics/sales', query: {...route.query, status: Status.All}}" 
                    :class="status === Status.All ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <span>Все</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/analytics/sales', query: {...route.query, status: Status.Active}}"  
                    :class="status === Status.Active ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <span>Активные</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/analytics/sales', query: {...route.query, status: Status.Closed}}" 
                    :class="status === Status.Closed ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <span>Закрытые</span>
                </BaseButton>
            </BaseButtonGroup>
            <BaseButtonGroup>
                <BaseButton color="default" :to="{path: '/analytics/sales', query: {...route.query, by: By.Budget}}" 
                    :class="by === By.Budget ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <span>По бюджету</span>
                </BaseButton>
                <BaseButton color="default" :to="{path: '/analytics/sales', query: {...route.query, by: By.Count}}"  
                    :class="by === By.Count ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                    <span>По количеству</span>
                </BaseButton>
            </BaseButtonGroup>
        </div>
        <ul class="flex flex-col gap-4 px-4">
            <li v-for="stage of sortedStages" :key="stage.id" class="flex items-end w-full border-b dark:border-muted-700">
                <div class="relative flex-1">
                    <div class="h-1 absolute bg-primary-400" :style="{
                        width: (durationRangeMap[stage.id][1] - durationRangeMap[stage.id][0]) / totals.duration * 100 + '%',
                        left: durationRangeMap[stage.id][0] / totals.duration * 100 + '%'
                    }">
                        <span 
                            class="absolute bottom-1 text-sm text-muted-600 font-light dark:text-muted-200"
                            :class="[getPercent(stage) > 0 && Math.floor(stage.average_time_in_stage / 1440) > 0 ? 'right-0' : 'left-0']"
                        >{{ Math.floor(stage.average_time_in_stage / 1440) }}д.</span>
                    </div>
                </div>
                <div class="flex items-start gap-4 flex-1">
                    <div class="flex gap-3 justify-end w-full">
                        <span class="text-lg font-light">{{getPercent(stage)}}%</span>
                        <div class="h-8 relateve transition-[width] duration-500" :style="{width: getPercent(stage) + '%', 'background-color': stage.color || '#04574d'}">
                            <span v-if="getPercent(stage) > 0" class="decoration" :style="{'--color': stage.color }"></span>
                        </div>
                    </div>
                    <div class="flex flex-col gap-0.5 text-xs text-muted-900 max-w-xs w-full shrink-0 dark:text-white">
                        {{ stage.name }}
                        <p class="text-muted-600 dark:text-muted-200">
                            <NuxtLink :to="{name: 'deals', query: {stage_id: stage.id, stage_name: stage.name}}" class="underline"> {{ stage.deal_count }} </NuxtLink> сделок <Money :value="stage.total_deal_budget" />
                        </p>
                    </div>
                </div>
            </li>
        </ul>
        <div>
            <h2 class="text-6xl font-extralight text-muted-900 dark:text-white">{{ Math.floor(Number(deals.average_deal_duration_in_minutes) / 1440) }}д.</h2>
            <span class="text-xl font-light mt-1">Средняя длительность сделки</span>
        </div>
    </div>
</template>

<style scoped>
.decoration {
    --color: #04574d;
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 0 10px 32px 0;
    position: absolute;
    left: -10px;
    bottom: 0;
    border-color: transparent var(--color, #04574d) transparent transparent;
}

</style>