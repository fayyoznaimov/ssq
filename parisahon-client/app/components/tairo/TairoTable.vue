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
const tableContainerRef = ref<HTMLDivElement>();
const widths = reactive<Record<string, {w: number, minw: number}>>({});
const savedWidths = ref<Record<string, number>>(JSON.parse(localStorage.getItem(props.localStorageKey) || '{}'));

onMounted(() => {
    const clone = tableRef.value?.cloneNode(true) as HTMLTableElement;
    clone.style.tableLayout = 'auto';
    clone.style.position = 'absolute';
    clone.style.zIndex = '-9999999999';
    clone.style.visibility = 'hidden';

    tableContainerRef.value?.appendChild(clone);
    const ths = clone.querySelectorAll('thead th');
    ths.forEach((th) => {
        const id = th.getAttribute('data-col-id');
        if (id) widths[id] = { w: savedWidths.value[id] || th.clientWidth, minw: th.clientWidth };
    });
    clone.remove();
});

</script>

<template>
    <div class="flex flex-col">
        <div
            class="border-muted-200 dark:border-muted-700 overflow-x-auto border no-scrollbar"
            :class="[
                props.shape === 'rounded' && 'rounded-md',
                props.shape === 'curved' && 'rounded-xl',
            ]"
            v-dragscroll="{ excluded: ['thead'] }"
        >
            <div class="inline-block min-w-full align-middle">
                <div class="overflow-hidden relative" ref="tableContainerRef">
                    <table
                        class="divide-muted-200 dark:divide-muted-700 min-w-full table-fixed divide-y text-left"
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
    </div>
</template>
