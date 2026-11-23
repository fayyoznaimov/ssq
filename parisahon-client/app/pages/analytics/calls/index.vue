<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-wrap items-center gap-4">
            <h1 class="text-xl whitespace-nowrap">Аналитика по звонкам</h1>
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
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="stats"
                :loading="isLoading"
                class="flex-auto"
                id="employee-analytics"
            >
            </BaseTable>
        </div>
        <p class="text-sm text-muted-500">Звонки — записи звонков за период по времени самого звонка, как в «Контроле» и «По менеджерам».</p>
    </div>
</template>

<script lang="ts" setup>
import moment from 'moment';
import DatePicker from '@vuepic/vue-datepicker';
import BaseTable from '~/components/common/BaseTable.vue';
import {type Column} from '~/components/common/types';
import type { CallStat } from '~/types/stats';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'По звонкам'
});

useHead({
    title: 'По звонкам'
});

const callsService = useService('analytics/calls', {auth: true});

const { data: stats, isLoading, run } = useAsync<CallStat[]>([]);
const sortBy = ref<Record<string, any>>({createdAt: -1});
const colorMode = useColorMode();
// the same default as «Контроль» and «По менеджерам»: the current month
const dateRange = ref([moment().startOf('month').format('YYYY-MM-DD'), moment().endOf('month').format('YYYY-MM-DD')]);

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
        if (preset.value[0].format('YYYY-MM-DD') === fromStr && preset.value[1].format('YYYY-MM-DD') === toStr) {
            return preset.label;
        }
    }
    return `${fromStr} - ${toStr}`;
}

const columns = ref<Column[]>([
    {
        label: 'Имя',
        name: 'user_name',
        resizable: true,
    },
    {
        label: 'Среднее время (мин)',
        name: 'avg_duration',
        resizable: true,
    },
    {
        label: 'Кол-во звонков',
        name: 'call_count',
        resizable: true,
    },
    {
        label: 'Кол-во исходящих',
        name: 'outgoing_call_count',
        resizable: true,
    },
    {
        label: 'Кол-во входящих',
        name: 'incoming_call_count',
        resizable: true,
    },
    {
        label: 'Исходящие (мин)',
        name: 'total_outgoing_duration',
        resizable: true,
    },
    {
        label: 'Входящие (мин)',
        name: 'total_incoming_duration',
        resizable: true,
    },
    {
        label: 'Всего (мин)',
        name: 'total_call_duration',
        resizable: true,
    },
]);

function fetchStats() {
    // the field cleared: all time
    if (!dateRange.value?.[0] || !dateRange.value?.[1]) return run(callsService.find().exec());
    run(callsService.find({
        from_date: dateRange.value[0],
        till_date: dateRange.value[1],
    }).exec());
}

watch(dateRange, fetchStats);
onMounted(fetchStats);
</script>

<style>
</style>
