<script setup lang="ts">
const props = withDefaults(
    defineProps<{
    shape?: 'straight' | 'rounded' | 'curved';
    localStorageKey: string;
  }>(),
    {
        shape: 'rounded',
    },
);

const tableRef = ref<HTMLTableElement>();
const scrollRef = ref<HTMLDivElement>();
/**
 * Only the widths a user set by dragging a column border (kept per table in localStorage).
 * The other columns take the width of their content: the table used to measure its columns by the
 * header text before the rows were loaded and fixed them (table-fixed), so «Имя» got 60 px and every
 * name was cut to «ad…».
 */
const widths = reactive<Record<string, {w: number, minw: number}>>({});
try {
    const saved = JSON.parse(localStorage.getItem(props.localStorageKey) || '{}') as Record<string, number>;
    for (const [id, w] of Object.entries(saved || {})) {
        if (Number.isFinite(w) && w > 0) widths[id] = { w, minw: 0 };
    }
} catch {
    // a broken value of an old version: the columns take the width of their content
}

/** columns hidden past the right / left edge: a shadow at that edge says the table scrolls */
const moreRight = ref(false);
const moreLeft = ref(false);

function updateEdges() {
    const el = scrollRef.value;
    if (!el) return;
    moreLeft.value = el.scrollLeft > 2;
    moreRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
}

let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
    updateEdges();
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(updateEdges);
        if (scrollRef.value) resizeObserver.observe(scrollRef.value);
        if (tableRef.value) resizeObserver.observe(tableRef.value);
    }
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
    <div class="relative flex flex-col">
        <div
            ref="scrollRef"
            class="tairo-table-scroll border-muted-200 dark:border-muted-700 overflow-x-auto border"
            :class="[
                props.shape === 'rounded' && 'rounded-md',
                props.shape === 'curved' && 'rounded-xl',
            ]"
            v-dragscroll="{ excluded: ['thead'] }"
            @scroll.passive="updateEdges"
        >
            <div class="inline-block min-w-full align-middle">
                <div class="relative">
                    <table
                        class="divide-muted-200 dark:divide-muted-700 min-w-full table-auto divide-y text-left"
                        ref="tableRef"
                        v-bind="$attrs"
                    >
                        <thead class="thead">
                            <tr>
                                <slot name="header" :widths="widths"></slot>
                            </tr>
                        </thead>
                        <tbody
                            class="divide-muted-200 dark:divide-muted-700 dark:bg-muted-800 divide-y bg-white"
                        >
                            <slot></slot>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
        <div
            v-show="moreLeft"
            class="pointer-events-none absolute inset-y-px start-px w-6 rounded-s-md bg-gradient-to-r from-muted-900/10 to-transparent dark:from-black/40"
            aria-hidden="true"
        />
        <div
            v-show="moreRight"
            class="pointer-events-none absolute inset-y-px end-px w-6 rounded-e-md bg-gradient-to-l from-muted-900/10 to-transparent dark:from-black/40"
            aria-hidden="true"
        />
    </div>
</template>

<style scoped>
/* a thin scrollbar that can be seen: columns past the right edge were not visible and nothing said so */
.tairo-table-scroll {
    scrollbar-width: thin;
    scrollbar-color: rgb(148 163 184 / 0.7) transparent;
}
.tairo-table-scroll::-webkit-scrollbar {
    height: 8px;
}
.tairo-table-scroll::-webkit-scrollbar-thumb {
    background: rgb(148 163 184 / 0.7);
    border-radius: 9999px;
}
.tairo-table-scroll::-webkit-scrollbar-track {
    background: transparent;
}
</style>
