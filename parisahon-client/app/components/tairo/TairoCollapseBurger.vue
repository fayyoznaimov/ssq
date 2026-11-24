<script setup lang="ts">
const { isOpen, isMobileOpen, toggle } = useCollapse();
const { lg } = useTailwindBreakpoints();
</script>

<template>
    <!-- the only way into the menu on a phone: dark lines on the light page, light ones on the dark page
         (it was #091EA5 on #0f172a, 1.5:1) -->
    <button
        type="button"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-muted-200/70 dark:hover:bg-muted-800"
        :aria-label="(lg ? isOpen : isMobileOpen) ? 'Свернуть меню' : 'Открыть меню'"
        @click="() => toggle()"
    >
        <div
            class="relative h-5 w-5"
            :class="[
                isOpen && lg ? 'scale-90' : '',
                isMobileOpen && !lg ? 'scale-90' : '',
            ]"
        >
            <span
                class="bg-muted-700 dark:bg-muted-200 absolute block h-0.5 w-full transition-all duration-300"
                :class="[
                    isOpen && lg ? 'top-1 max-w-[75%] -rotate-45' : 'top-0.5',
                    isMobileOpen && !lg ? 'top-1 max-w-[75%] -rotate-45' : 'top-0.5',
                ]"
            ></span>
            <span
                class="bg-muted-700 dark:bg-muted-200 absolute top-1/2 block h-0.5 w-full max-w-[50%] transition-all duration-300"
                :class="[
                    isOpen && lg ? 'translate-x-4 opacity-0' : '',
                    isMobileOpen && !lg ? 'translate-x-4 opacity-0' : '',
                ]"
            ></span>
            <span
                class="bg-muted-700 dark:bg-muted-200 absolute block h-0.5 w-full transition-all duration-300"
                :class="[
                    isOpen && lg ? 'bottom-1 max-w-[75%] rotate-45' : 'bottom-0',
                    isMobileOpen && !lg ? 'bottom-1 max-w-[75%] rotate-45' : 'bottom-0',
                ]"
            ></span>
        </div>
    </button>
</template>
