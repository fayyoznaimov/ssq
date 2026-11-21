<script lang="ts" setup>
import moment from 'moment';
import BaseButton from '~/components/base/BaseButton.vue';
import DatePicker from '@vuepic/vue-datepicker';
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

const progressEls = ref<Record<string, HTMLProgressElement>>({});
const route = useRoute();
const period = ref(route.query.period || Period.Monthly);
const colorMode = useColorMode();
const dateRange = ref([moment().set('year', 2020).startOf('year').format('YYYY-MM-DD'), moment().set('year', 2100).endOf('year').format('YYYY-MM-DD')]);
const objectiveResultService = useService('analytics/objectives/results');
const {data: results, run: runResults} = useAsync<{groups: ObjectiveResultStat[]}>({groups: []});

const presetDates = ref([
    { label: 'За сегодня', value: [moment().startOf('day'), moment().startOf('day')] },
    { label: 'За вчера', value: [moment().subtract(1, 'day').startOf('day'), moment().subtract(1, 'day').startOf('day')] },
    { label: 'За последние 30 дней', value: [moment().subtract(30, 'day').startOf('day'), moment().startOf('day')] },
    { label: 'За эту неделю', value: [moment().startOf('week'), moment().endOf('week')] },
    { label: 'За прошлую неделю', value: [moment().subtract(1, 'week').startOf('week'), moment().subtract(1, 'week').endOf('week')] },
    { label: 'За этот месяц', value: [moment().startOf('month'), moment().endOf('month')] },
    { label: 'За прошлый месяц', value: [moment().subtract(1, 'month').startOf('month'), moment().subtract(1, 'month').endOf('month')] },
    { label: 'За квартал', value: [moment().startOf('quarters'), moment().endOf('quarters')] },
    { label: 'За этот год', value: [moment().startOf('year'), moment().endOf('year')] },
    { label: 'За все время', value: [moment().set('year', 2020).startOf('year'), moment().set('year', 2100).endOf('year')] },
]);

function format(dates: Date[]) {
    const fromStr = moment(dates[0]).format('YYYY-MM-DD');
    const toStr = moment(dates[1]).format('YYYY-MM-DD');
    for (const preset of presetDates.value) {
        const presetFromStr = preset.value[0].format('YYYY-MM-DD')
        const presetToStr = preset.value[1].format('YYYY-MM-DD');
        if (presetFromStr === fromStr && presetToStr === toStr) {
            return preset.label;
        }
    }

    return `${fromStr} - ${toStr}`;
}

function fetchStats() {
    runResults(objectiveResultService.find({
        from_date: dateRange.value[0],
        till_date: dateRange.value[1],
    }).exec());
}

const total = computed(() => {
    let budget = 0; 
    let goal = 0;
    for (const group of results.value.groups) {
        if (group.objectives == null) continue;
        goal += group.objectives[period.value as Period];
        budget += group.total_budget;
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

watchEffect(() => {
    period.value = route.query.period || Period.Monthly;
});

watch(dateRange, fetchStats);
onMounted(fetchStats);
</script>
<template>
    <div class="flex flex-col gap-8">
        <div class="flex justify-between">
            <div class="flex items-center gap-4">
                <h1 class="text-xl whitespace-nowrap">Цели по сделкам</h1>
                <div class="max-w-xs w-full shrink-0">
                    <DatePicker 
                        v-model="dateRange"
                        :format="format"
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
                            <BaseInput :value="value" @input="onInput" @blur="onBlur" @paste="onPaste" placeholder="За все время" />
                        </template>
                    </DatePicker>
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
                <li v-for="group in results.groups">
                    <div class="text-muted-700 flex gap-3 items-center dark:text-muted-200">
                        <span class="font-semibold text-lg max-w-40 w-full">{{ group.name }}</span>
                        <progress 
                            class="max-w-2xl w-full progress" 
                            :data-budget="formatMoney(group.total_budget, 0, {spaceBetweenAmountAndSymbol: ' ', symbolOnLeft: false})" 
                            :value="group.total_budget" 
                            :max="group.objectives?.[period as Period]"
                            :ref="(el) => progressEls[group.id] = el as HTMLProgressElement"
                        >
                        </progress>
                        <Money :value="group.objectives?.[period as Period] || 0" />
                    </div>
                    <ul class="flex flex-col gap-4 mt-4">
                        <li v-for="user in group.users" class="text-muted-700 flex gap-3 items-center dark:text-muted-200">
                            <span class="max-w-40 w-full">{{ user.username }}</span>
                            <progress 
                                class="max-w-2xl w-full progress" 
                                :value="user.total_budget" 
                                :max="user.objectives[period as Period]"
                                :data-budget="formatMoney(user.total_budget, 0, {spaceBetweenAmountAndSymbol: ' ', symbolOnLeft: false})" 
                                :ref="(el) => progressEls[group.id] = el as HTMLProgressElement"
                            >
                            </progress>
                            <Money :value="user.objectives[period as Period]" />
                        </li>
                    </ul>
                </li>
            </ul>
            <p v-else class="text-amber-500 text-sm mt-2">
                <Icon name="ph:warning" />
                Недастаточно данных для отображения
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