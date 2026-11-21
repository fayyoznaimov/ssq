<script lang="ts" setup>
import ResizableTh from '~/components/common/ResizableTh.vue';
const th = ref<HTMLTableCellElement>();
const props = withDefaults(
    defineProps<{
        uppercase?: boolean;
        spaced?: boolean;
        resizable?: boolean;
        width: { minw: number, w: number };
        name: string;
        localStorageKey: string;
    }>(),
    {
        uppercase: false,
        spaced: false,
        width: () => ({minw: 0, w: 100}),
    },
);

</script>

<template>
    <th
        ref="th"
        :class="[
            props.uppercase ? 'text-xs uppercase' : 'text-sm',
            props.spaced
                ? 'border-muted-200 dark:border-muted-700 last:border-e-none dark:bg-muted-800 border-r bg-white px-4 py-5'
                : 'bg-muted-50 dark:bg-muted-800 py-3',
        ]"
        class="text-muted-700 dark:text-muted-400 text-left font-sans font-semibold tracking-wider"
        :data-col-id="props.name"
        :style="{ width: `${width.w}px`, minWidth: `${width.minw}px` }"
    >
        <slot></slot>
        <ResizableTh v-if="props.resizable && th" :th="th" :localStorageKey="localStorageKey" />
    </th>
</template>
