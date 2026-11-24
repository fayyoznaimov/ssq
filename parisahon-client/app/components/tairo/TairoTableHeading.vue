<script lang="ts" setup>
import ResizableTh from '~/components/common/ResizableTh.vue';
const th = ref<HTMLTableCellElement>();
const props = withDefaults(
    defineProps<{
        uppercase?: boolean;
        spaced?: boolean;
        resizable?: boolean;
        // a width the user set by dragging the border; without it the column takes the width of its content
        width?: { minw: number, w: number };
        name: string;
        localStorageKey: string;
    }>(),
    {
        uppercase: false,
        spaced: false,
        width: () => ({minw: 0, w: 0}),
    },
);

const widthStyle = computed(() => {
    const style: Record<string, string> = {};
    if (props.width?.w > 0) style.width = `${props.width.w}px`;
    if (props.width?.minw > 0) style.minWidth = `${props.width.minw}px`;
    return style;
});
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
        class="text-muted-700 dark:text-muted-300 text-left font-sans font-semibold tracking-wider"
        :data-col-id="props.name"
        :style="widthStyle"
    >
        <slot></slot>
        <ResizableTh v-if="props.resizable && th" :th="th" :localStorageKey="localStorageKey" />
    </th>
</template>
