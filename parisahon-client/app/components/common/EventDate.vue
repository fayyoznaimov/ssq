<template>
    <!-- when (the day is the separator above; full date on hover) and who did it -->
    <span class="whitespace-nowrap" :title="full">{{ withDate ? full : time }}</span>
    <span
        class="ml-2 font-medium text-muted-700 dark:text-muted-200"
        :title="event.originated_by?.deleted_at ? 'Учётная запись удалена' : undefined"
    >{{ author }}</span>
</template>

<script setup lang="ts">
import type { DealEvent } from '~/types/deal';
import { personName, timeOf } from './feed';

const props = withDefaults(defineProps<{ event: DealEvent | any; withDate?: boolean; at?: string | null }>(), {
    withDate: false,
    at: null,
});

const moment = computed(() => props.at || props.event.created_at);
const time = computed(() => timeOf(moment.value));
const full = computed(() => (moment.value ? new Date(moment.value).toLocaleString('ru') : ''));
const author = computed(() => personName(props.event.originated_by));
</script>
