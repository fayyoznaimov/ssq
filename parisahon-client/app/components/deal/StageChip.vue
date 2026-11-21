<template>
    <span
        class="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 text-muted-700 dark:text-muted-100"
        :class="stage?.color ? '' : 'border-muted-300 bg-muted-100 dark:border-muted-600 dark:bg-muted-700'"
        :style="stage?.color ? { borderColor: stage.color, backgroundColor: stage.color + '33' } : undefined"
        :title="stage?.name"
    >
        <span class="size-1.5 shrink-0 rounded-full" :style="{ backgroundColor: stage?.color || 'currentColor' }" />
        <span class="truncate">{{ stage?.name || 'Без этапа' }}</span>
    </span>
</template>

<script lang="ts" setup>
/** A deal's stage as a small chip in the stage's own color (lists of deals of a client / company / contact). */
defineProps<{ stage?: { name: string; color?: string | null } | null }>();
</script>
