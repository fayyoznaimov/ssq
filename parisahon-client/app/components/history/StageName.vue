<template>
    <!-- a stage in its colour, readable in both themes (stageTones): the history, the deal header -->
    <span
        class="stage-name inline-flex max-w-full items-center rounded px-1.5 py-0.5 align-baseline text-[12px] font-semibold leading-4 ring-1 ring-inset ring-black/10 dark:ring-white/10"
        :class="tones['--stage-bg'] ? 'stage-name--coloured' : 'bg-muted-100 text-muted-700 dark:bg-muted-700 dark:text-muted-100'"
        :style="tones"
        :title="name || undefined"
    ><span class="truncate">{{ name || '—' }}</span></span>
</template>

<script setup lang="ts">
import { stageTones } from './history';

const props = defineProps<{ name?: string | null; color?: string | null }>();
const tones = computed(() => stageTones(props.color));
</script>

<style scoped>
.stage-name--coloured {
    background-color: var(--stage-bg);
    color: var(--stage-fg);
}
:global(.dark) .stage-name--coloured {
    background-color: var(--stage-bg-dark);
    color: var(--stage-fg-dark);
}
</style>
