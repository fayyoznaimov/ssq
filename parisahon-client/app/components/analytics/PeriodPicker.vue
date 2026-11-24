<template>
    <div class="w-full sm:max-w-xs">
        <DatePicker
            :model-value="inner"
            :format="format"
            range
            text-input
            vertical
            :preset-dates="presets"
            auto-apply
            :enable-time-picker="false"
            model-type="yyyy-MM-dd"
            :teleport="true"
            :dark="colorMode.value === 'dark'"
            locale="ru"
            @update:model-value="onPick"
        >
            <template #dp-input="{ onInput, value, onBlur, onPaste }">
                <BaseInput :value="value" icon="ph:calendar-blank" :placeholder="allTime ? 'За всё время' : 'Период'" @input="onInput" @blur="onBlur" @paste="onPaste" />
            </template>
        </DatePicker>
    </div>
</template>

<script lang="ts" setup>
/**
 * The period of a report (one for all of «Аналитика», see useReportPeriod): presets from «Сегодня» to
 * «За всё время», the chosen preset is named in the field. v-model: [first day, last day] or null (all time).
 */
import moment from 'moment';
import DatePicker from '@vuepic/vue-datepicker';
import { ALL_TIME_FROM, ALL_TIME_TILL, type ReportPeriod } from '~/composables/useReportPeriod';

const props = withDefaults(defineProps<{ modelValue: ReportPeriod; allTime?: boolean }>(), { allTime: true });
const emit = defineEmits<{ (e: 'update:modelValue', value: ReportPeriod): void }>();

const colorMode = useColorMode();
const day = (m: moment.Moment) => m.format('YYYY-MM-DD');

const presetList = computed(() => {
    const now = moment();
    const list: { label: string; value: [string, string] }[] = [
        { label: 'Сегодня', value: [day(now.clone()), day(now.clone())] },
        { label: 'Вчера', value: [day(now.clone().subtract(1, 'day')), day(now.clone().subtract(1, 'day'))] },
        { label: 'Эта неделя', value: [day(now.clone().startOf('isoWeek')), day(now.clone().endOf('isoWeek'))] },
        { label: 'Прошлая неделя', value: [day(now.clone().subtract(1, 'week').startOf('isoWeek')), day(now.clone().subtract(1, 'week').endOf('isoWeek'))] },
        { label: 'Последние 30 дней', value: [day(now.clone().subtract(29, 'day')), day(now.clone())] },
        { label: 'Этот месяц', value: [day(now.clone().startOf('month')), day(now.clone().endOf('month'))] },
        { label: 'Прошлый месяц', value: [day(now.clone().subtract(1, 'month').startOf('month')), day(now.clone().subtract(1, 'month').endOf('month'))] },
        { label: 'Этот квартал', value: [day(now.clone().startOf('quarter')), day(now.clone().endOf('quarter'))] },
        { label: 'Этот год', value: [day(now.clone().startOf('year')), day(now.clone().endOf('year'))] },
        { label: 'Прошлый год', value: [day(now.clone().subtract(1, 'year').startOf('year')), day(now.clone().subtract(1, 'year').endOf('year'))] },
    ];
    if (props.allTime) list.push({ label: 'За всё время', value: [ALL_TIME_FROM, ALL_TIME_TILL] });
    return list;
});

// the date picker takes the presets as dates
const presets = computed(() => presetList.value.map((p) => ({ label: p.label, value: [moment(p.value[0]).toDate(), moment(p.value[1]).toDate()] })));

const inner = computed(() => props.modelValue ?? null);

function format(dates: Date[]) {
    const from = moment(dates?.[0]).format('YYYY-MM-DD');
    const till = moment(dates?.[1] ?? dates?.[0]).format('YYYY-MM-DD');
    const preset = presetList.value.find((p) => p.value[0] === from && p.value[1] === till);
    if (preset) return preset.label;
    return `${moment(from).format('DD.MM.YYYY')} — ${moment(till).format('DD.MM.YYYY')}`;
}

function onPick(value: string[] | null) {
    if (!value || !value[0]) {
        // the field cleared: all time (or nothing to change where all time is not offered)
        if (props.allTime) emit('update:modelValue', null);
        return;
    }
    const from = value[0];
    const till = value[1] || value[0];
    if (from === ALL_TIME_FROM && till === ALL_TIME_TILL) return emit('update:modelValue', null);
    emit('update:modelValue', [from, till]);
}
</script>
