<template>
    <a
        v-if="hyperlink && props.value"
        :href="href"
        class="whitespace-nowrap"
    >{{ formatted }}</a>
    <span v-else class="whitespace-nowrap">{{ formatted }}</span>
</template>

<script lang="ts" setup>
import { formatPhone } from '~/utils/format';

const props = defineProps<{value: string, hyperlink?: boolean}>();

// by the country code: +998 (90) 111-00-09, +7 (925) 873-13-28; one fixed mask turned
// +79258731328 into «+792 (58) 731-32-8»
const formatted = computed(() => formatPhone(props.value));
const href = computed(() => `tel:${String(props.value ?? '').replace(/[^\d+]/g, '')}`);
</script>
