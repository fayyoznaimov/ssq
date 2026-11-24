<script setup lang="ts">
const props = defineProps<{
  th: HTMLTableCellElement;
  localStorageKey: string;
}>();

function getPageX(e: MouseEvent | TouchEvent) {
    if (e instanceof MouseEvent) {
        return Math.floor(e.pageX);
    }
    return Math.floor(e.changedTouches[0].pageX);
}

let moveFn: (e: MouseEvent | TouchEvent) => void;

// the narrowest a column can be dragged to
const MIN_WIDTH = 48;

/** the width of the column now: the one set by dragging, or the one it took from its content */
function currentWidth() {
    return parseInt(props.th.style.width, 10) || Math.round(props.th.getBoundingClientRect().width);
}

function onStart(e: MouseEvent | TouchEvent) {
    e.preventDefault();
    const offsetStart = currentWidth() - getPageX(e);

    moveFn = (e) => onMove(e, offsetStart);

    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
    document.addEventListener('mousemove', moveFn);
    document.addEventListener('touchmove', moveFn);
}

function onMove(e: MouseEvent | TouchEvent, offsetStart: number) {
    e.stopPropagation();

    if (offsetStart + getPageX(e) >= (parseInt(props.th.style.minWidth, 10) || MIN_WIDTH)) {
        const newWidth = offsetStart + getPageX(e);
        requestAnimationFrame(() => {
            props.th.style.width = `${newWidth}px`;
        });
    }
}

function onEnd(e: MouseEvent | TouchEvent) {
    e.preventDefault();

    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('mousemove', moveFn);
    document.removeEventListener('touchmove', moveFn);
    document.removeEventListener('touchend', onEnd);

    let existing = JSON.parse(window.localStorage.getItem(props.localStorageKey) || null!);
    if (existing == null) existing = {};
    const width = parseInt(props.th.style.width, 10);
    if (!width) return;
    existing[props.th.getAttribute('data-col-id')!] = width;
    window.localStorage.setItem(props.localStorageKey, JSON.stringify(existing));
}

</script>

<template>
    <button 
        @mousedown="onStart"
        @touchstart.passive="onStart"
        @click="(e) => e.preventDefault()"
        class="h-12 w-3 block absolute right-0 -translate-y-1/2 top-1/2 cursor-ew-resize after:absolute after:top-0 after:left-1/2 after:-translate-x-1/2 after:w-0.5 after:bg-muted-200 dark:after:bg-muted-700 after:h-full">
    </button>
</template>