<script setup lang="ts">
import DatePicker from '@vuepic/vue-datepicker';
import AddonApexcharts from '~/components/tairo/AddonApexcharts.vue';
import type { ConsolidatedStats } from '~/types/stats';
import moment from 'moment';
import Money from '~/components/common/Money.vue';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Сводный отчет'
});

useHead({
    title: 'Сводный отчет'
});

const dateRange = ref([moment().set('year', 2020).startOf('year').format('YYYY-MM-DD'), moment().set('year', 2100).endOf('year').format('YYYY-MM-DD')]);
const consolidatedService = useService('/analytics/consolidated-report', {auth: true});
const {data: consolidated, isLoading: consolidatedLoading, run: runConsolidated} = useAsync<ConsolidatedStats>({
    graph: [],
    deals: {
        total_stats: {
            total_deal_budget: 0,
            total_deal_count: 0,
            won_deal_count: 0,
            won_deal_budget: 0,
            lost_deal_count: 0,
            lost_deal_budget: 0,
        },
        stage_stats: [],
        user_stats: []
    },
    contacts: {
        total_stats: {
            total_ctr_agent_count: 0,
            total_company_count: 0,
        },
        user_stats: [],
    },
    tasks: {
        total_stats: {
            count: 0
        },
        user_stats: [],
        type_stats: []
    }
});

enum Period {
    Weekly = 'weekly',
    Monthly = 'monthly',
    Yearly = 'yearly'
}

const route = useRoute();
const colorMode = useColorMode();
const period = ref(route.query.period || Period.Weekly);

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

watchEffect(() => {
    period.value = route.query.period || Period.Weekly;
})

watch(() => [period.value, dateRange.value], fetchConsolidatedStats);

function fetchConsolidatedStats() {
    runConsolidated(consolidatedService.find({
        period: period.value,
        from_date: dateRange.value[0],
        till_date: dateRange.value[1],
    }).exec());
}

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

const COLORS = ['#4f46e5', '#fb923c', '#f43f5e', '#db2777', '#7c3aed', '#16a34a'];

const consolidatedByPeriods = computed(() => {
    const type = 'line';
    const height = 400;

    const series: {name: string, data: number[]}[] = [
        {
            name: 'Новых',
            data: [],
        },
        {
            name: 'Выигранных',
            data: [],
        },
        {
            name: 'Закрытых без успеха',
            data: [],
        }
    ];

    const categories: string[] = [];
    for (const item of consolidated.value.graph) {
        categories.push(`${moment(item.date_start).format('YYYY-MM-DD')} - ${moment(item.date_end).format('YYYY-MM-DD')}`);
        series[0].data.push(item.new_count);
        series[1].data.push(item.won_count);
        series[2].data.push(item.lost_count);
    }

    const options = {
        chart: {
            zoom: {
                enabled: false,
            },
            toolbar: {
                show: false,
            },
        },
        colors: COLORS,
        dataLabels: {
            enabled: false,
        },
        stroke: {
            width: [2, 2, 2],
            curve: 'smooth',
            dashArray: [0, 8, 5],
        },
        title: {
            text: '',
            align: 'left',
        },
        legend: {
            tooltipHoverFormatter: function (val: string, opts: any) {
                return `${val} - ${opts.w.globals.series[opts.seriesIndex][opts.dataPointIndex]}`;
            },
            position: 'top',
            horizontalAlign: 'left'
        },
        markers: {
            size: 0,
            hover: {
                sizeOffset: 6,
            },
        },
        xaxis: {
            categories,
        },
        grid: {
            borderColor: '#f1f1f1',
        },
    };

    return {
        type,
        height,
        options,
        series,
    };
});

const consolidatedByDeals = computed(() => {
    const type = 'donut';
    const height = 400;
    const stageSeries: number[] = [];
    const userSeries: number[] = [];
    const stageLabels: string[] = [];
    const userLabels: string[] = [];
    for (const item of consolidated.value.deals.stage_stats) {
        stageSeries.push(Number(item.deal_count_in_stage));
        stageLabels.push(item.name);
    }

    for (const item of consolidated.value.deals.user_stats) {
        userSeries.push(Number(item.deal_count));
        userLabels.push(item.username);
    }

    const options = {
        colors: COLORS,
        dataLabels: {
            enabled: false,
        },
        stroke: {
            width: 0,
        },
        title: {
            text: '',
            align: 'left',
        },
        legend: {
            show: false,
        },
        responsive: [{
            breakpoint: 480,
            options: {
                chart: {
                    width: 200
                },
                legend: {
                    show: false
                },
            }
        }],
        plotOptions: {
            pie: {
                donut: {
                    labels: {
                        show: true,
                        value: {
                            fontSize: '50px',
                            fontWeight: 400,
                        },
                        name: {
                            offsetY: 54,
                            fontWeight: 400,
                        },
                        total: {
                            label: 'Всего сделок',
                            show: true,
                            fontWeight: 400,
                            color: colorMode.value === 'dark' ? '#94a3b8' : '#64748b',
                            formatter() {
                                return consolidated.value.deals.total_stats.total_deal_count;
                            }
                        }
                    }
                }
            }
        },

    };

    return {
        stages: {
            type,
            height,
            options: {
                ...options, 
                labels: stageLabels, 
            },
            series: stageSeries,
        },
        users: {
            type,
            height,
            options: {
                ...options, 
                labels: userLabels,
            },
            series: userSeries,
        }
    }
});

const consolidatedByContacts = computed(() => {
    const type = 'donut';
    const height = 400;
    const series: number[] = [consolidated.value.contacts.total_stats.total_company_count, consolidated.value.contacts.total_stats.total_ctr_agent_count];
    const labels: string[] = ['Компании', 'Контакты'];

    const options = {
        colors: COLORS,
        dataLabels: {
            enabled: false,
        },
        stroke: {
            width: 0,
        },
        title: {
            text: '',
            align: 'left',
        },
        legend: {
            position: 'bottom',
        },
        responsive: [{
            breakpoint: 480,
            options: {
                chart: {
                    width: 200
                },
                legend: {
                    show: false
                },
            }
        }],
        labels,
        plotOptions: {
            pie: {
                donut: {
                    labels: {
                        show: true,
                        value: {
                            fontSize: '50px',
                            fontWeight: 400,
                        },
                        name: {
                            offsetY: 54,
                            fontWeight: 400,
                        },
                        total: {
                            label: 'Все контакты',
                            show: true,
                            fontWeight: 400,
                            color: colorMode.value === 'dark' ? '#94a3b8' : '#64748b',
                            formatter() {
                                return Number(consolidated.value.contacts.total_stats.total_company_count) + Number(consolidated.value.contacts.total_stats.total_ctr_agent_count);
                            }
                        }
                    }
                }
            }
        },

    };


    return {
        type,
        height,
        options,
        series,
    }
});

const consolidatedByTasks = computed(() => {
    const type = 'donut';
    const height = 400;
    const series: number[] = [];
    const labels: string[] = [];
    for (const item of consolidated.value.tasks.type_stats) {
        if (item.id == null) continue;
        labels.push(item.name);
        series.push(Number(item.task_count));
    }

    const options = {
        colors: COLORS,
        dataLabels: {
            enabled: false,
        },
        stroke: {
            width: 0,
        },
        title: {
            text: '',
            align: 'left',
        },
        legend: {
            show: false,
        },
        responsive: [{
            breakpoint: 480,
            options: {
                chart: {
                    width: 200
                },
                legend: {
                    show: false
                },
            }
        }],
        labels,
        plotOptions: {
            pie: {
                donut: {
                    labels: {
                        show: true,
                        value: {
                            fontSize: '50px',
                            fontWeight: 400,
                        },
                        name: {
                            offsetY: 54,
                            fontWeight: 400,
                        },
                        total: {
                            label: 'Все задачи',
                            show: true,
                            fontWeight: 400,
                            color: colorMode.value === 'dark' ? '#94a3b8' : '#64748b',
                            formatter() {
                                return consolidated.value.tasks.total_stats.count;
                            }
                        }
                    }
                }
            }
        },

    };

    return {
        type,
        height,
        options,
        series,
    }
});

onMounted(fetchConsolidatedStats);

</script>
<template>
    <div class="flex flex-col gap-8">
        <div class="flex items-center gap-4">
            <h1 class="text-xl">
                Сводный отчет
            </h1>
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
        <BaseCard class="p-6 flex flex-col gap-6">
            <div class="flex items-center justify-between">
                <BaseHeading
                    as="h3"
                    size="md"
                    weight="semibold"
                    lead="tight"
                    class="text-muted-800 dark:text-white"
                >
                    Сделки
                </BaseHeading>
                <BaseButtonGroup>
                    <BaseButton color="default" :to="{path: '/analytics/consolidated', query: {...route.query, period: Period.Weekly}}" 
                        :class="period === Period.Weekly ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                        <span>По неделям</span>
                    </BaseButton>
                    <BaseButton color="default" :to="{path: '/analytics/consolidated', query: {...route.query, period: Period.Monthly}}"  
                        :class="period === Period.Monthly ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                        <span>По месяцам</span>
                    </BaseButton>
                    <BaseButton color="default" :to="{path: '/analytics/consolidated', query: {...route.query, period: Period.Yearly}}" 
                        :class="period === Period.Yearly ? '!bg-muted-200 dark:!bg-muted-600' : ''">
                        <span>По годам</span>
                    </BaseButton>
                </BaseButtonGroup>
            </div>
            <AddonApexcharts v-bind="consolidatedByPeriods" />
        </BaseCard>
        <BaseCard class="p-6 flex flex-col gap-6">
            <BaseHeading
                as="h3"
                size="md"
                weight="semibold"
                lead="tight"
                class="text-muted-800 dark:text-white"
            >
                Сделки
            </BaseHeading>
            <div class="flex gap-4 w-full">
                <div class="max-w-sm w-full shrink-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Этапы продаж</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="stage of consolidated.deals.stage_stats">
                            <NuxtLink :to="{name: 'deals', query: {stage_id: stage.id, stage_name: stage.name}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-16 text-right">
                                    {{Math.floor(Number(stage.deal_count_in_stage) / Number(consolidated.deals.total_stats.total_deal_count) * 100)}}%
                                </div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200">
                                    <span>
                                        {{stage.name}}
                                    </span>
                                    <p>
                                        <span>{{ stage.deal_count_in_stage }} сделок, </span>
                                        <Money :value="Number(stage.total_budget_in_stage)" />
                                    </p>
                                </div>
                            </NuxtLink>
                        </li>
                    </ul>
                </div>
                <div class="flex flex-col gap-4 w-full">
                    <AddonApexcharts v-bind="consolidatedByDeals.stages" />
                    <AddonApexcharts v-bind="consolidatedByDeals.users" />
                </div>
                <div class="max-w-sm w-full shrink-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Сделки по менеджеру</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="user of consolidated.deals.user_stats">
                            <NuxtLink :to="{name: 'deals', query: {user_id: user.id, username: user.username}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-16 text-right">
                                    {{Math.floor(Number(user.deal_count) / Number(consolidated.deals.total_stats.total_deal_count) * 100)}}%
                                </div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200">
                                    <span>
                                        {{user.username}}
                                    </span>
                                    <p>
                                        <span>{{ user.deal_count }} сделок, </span>
                                        <Money :value="Number(user.deal_budget)" />
                                    </p>
                                </div>
                            </NuxtLink>
                        </li>
                    </ul>
                </div>
            </div>
        </BaseCard>
        <BaseCard class="p-6 flex flex-col gap-6">
            <BaseHeading
                as="h3"
                size="md"
                weight="semibold"
                lead="tight"
                class="text-muted-800 dark:text-white"
            >
                Контакты
            </BaseHeading>
            <div class="flex justify-between">
                <div>
                    <AddonApexcharts v-bind="consolidatedByContacts" />
                </div>
                <div class="max-w-sm w-full shrink-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Контакты по менеджерам</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="manager of consolidated.contacts.user_stats">
                            <NuxtLink :to="{name: 'lists-contacts', query: {user_id: manager.id, username: manager.username}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-16 text-right">
                                    {{Math.floor((Number(manager.company_count) + Number(manager.ctr_agent_count)) / (Number(consolidated.contacts.total_stats.total_company_count) + Number(consolidated.contacts.total_stats.total_ctr_agent_count)) * 100)}}%
                                </div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200">
                                    <span>
                                        {{manager.username}}
                                    </span>
                                    <span>
                                        {{Number(manager.company_count) + Number(manager.ctr_agent_count)}} контактов
                                    </span>
                                </div>
                            </NuxtLink>
                        </li>
                    </ul>
                </div>
            </div>
        </BaseCard>
        <BaseCard class="p-6 flex flex-col gap-6">
            <BaseHeading
                as="h3"
                size="md"
                weight="semibold"
                lead="tight"
                class="text-muted-800 dark:text-white"
            >
                Задачи
            </BaseHeading>
            <div class="flex justify-between">
                <div class="w-full">
                    <AddonApexcharts v-bind="consolidatedByTasks" />
                </div>
                <div class="max-w-sm w-full shrink-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Задачи по типу</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="type of consolidated.tasks.type_stats">
                            <NuxtLink :to="{name: 'tasks', query: {type_id: type.id, type_name: type.name}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-16 text-right">
                                    {{Math.floor(Number(type.task_count) / Number(consolidated.tasks.total_stats.count) * 100)}}%
                                </div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200">
                                    <span>
                                        {{type.name}}
                                    </span>
                                    <span>
                                        {{type.task_count}} задач
                                    </span>
                                </div>
                            </NuxtLink>
                        </li>
                    </ul>
                </div>
                <div class="max-w-sm w-full shrink-0">
                    <h3 class="text-xs uppercase text-gray-500 font-semibold dark:text-muted-300">Задачи по менеджерам</h3>
                    <ul class="flex flex-col gap-2 mt-4">
                        <li v-for="manager of consolidated.tasks.user_stats">
                            <NuxtLink :to="{name: 'tasks', query: {user_id: manager.id, username: manager.username}}" class="flex items-center gap-3">
                                <div class="text-2xl font-thin w-16 text-right">
                                    {{Math.floor(Number(manager.task_count) / (Number(consolidated.tasks.total_stats.count)) * 100)}}%
                                </div>
                                <div class="flex flex-col border-l-2 border-muted-200 px-3 text-muted-600 text-sm dark:text-muted-200">
                                    <span>
                                        {{manager.username}}
                                    </span>
                                    <span>
                                        {{ manager.task_count }} задач
                                    </span>
                                </div>
                            </NuxtLink>
                        </li>
                    </ul>
                </div>
            </div>
        </BaseCard>
    </div>
</template>

<style scoped>

</style>
