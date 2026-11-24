<template>
    <!-- cents only when there are any (deal amounts are numeric(18,2)) -->
    <span v-bind="$attrs">{{ formatMoney(amount, Number.isInteger(amount) ? 0 : 2, {spaceBetweenAmountAndSymbol: ' ', symbolOnLeft: false}) }}</span>
</template>

<script lang="ts" setup>
import {formatMoney} from '~/utils/text';

const props = defineProps<{ value: number | string }>();
// the API gives numeric columns as text ("1250.5"); no value stays empty
const amount = computed(() => props.value === null || props.value === undefined || props.value === '' ? NaN : Number(props.value));
</script>
