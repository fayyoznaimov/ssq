<template>
    <div class="flex flex-col gap-8">
        <div class="flex items-center gap-4">
            <h1 class="text-xl whitespace-nowrap">Аналитика по сотрудникам</h1>
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

    </div>
</template>

<script lang="ts" setup>
import moment from 'moment';
import BaseTable from '~/components/common/BaseTable.vue';
import DatePicker from '@vuepic/vue-datepicker';
import {type Column} from '~/components/common/types';
import type { UserStat } from '~/types/stats';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'По сотрудникам'
});

useHead({
    title: 'По сотрудникам'
});

const userService = useService('analytics/users', {auth: true});

const { data: stats, isLoading, run } = useAsync<UserStat[]>([]);
const sortBy = ref<Record<string, any>>({createdAt: -1});
const colorMode = useColorMode();
const dateRange = ref([moment().set('year', 2020).startOf('year').format('YYYY-MM-DD'), moment().set('year', 2100).endOf('year').format('YYYY-MM-DD')]);

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


const columns = ref<Column[]>([
    {
        label: 'Имя',
        name: 'username',
        resizable: true,
    },
    {
        label: 'Кол-во сделок',
        name: 'deal_count',
        resizable: true,
    },
    {
        label: 'Сумма сделок',
        name: 'deal_budget',
        resizable: true,
        money: true
    },
    {
        label: 'Кол-во задач',
        name: 'task_count',
    },
]);

watch(dateRange, () => {
    run(userService.find({
      from_date: dateRange.value[0],
      till_date: dateRange.value[1],
    }).exec());
});

onMounted(() => {
    run(userService.find({
      from_date: dateRange.value[0],
      till_date: dateRange.value[1],
    }).exec());
});
</script>

<style>
</style>
