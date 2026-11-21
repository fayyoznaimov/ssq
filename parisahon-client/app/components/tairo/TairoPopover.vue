<script setup lang="ts">
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue';

import Dummy from './PopoverDummy.vue';

const props = withDefaults(
    defineProps<{
    /**
     * The shape of the popover.
     */
    shape?: 'straight' | 'rounded' | 'curved'

    /**
     * The size of the popover.
     */
    size?: 'sm' | 'md' | 'lg' | '2md'

    /**
     * The orientation of the popover.
     */
    orientation?: 'start' | 'end'
    class?: string | string[],
  }>(),
    {
        shape: 'rounded',
        size: 'md',
        orientation: 'start',
    },
);

const emits = defineEmits<{
    (e: 'change', value: boolean): void;
}>();
</script>

<template>
    <div class="relative">
        <Popover class="relative" v-slot="{open}">
            <Dummy :open="open" @change="emits('change', $event)" />
            <PopoverButton
                class="group inline-flex cursor-pointer font-sans focus:outline-none"
                as="div"
                v-slot="{open}"
            >
                <slot :open="open"></slot>
            </PopoverButton>

            <Transition
                enter-active-class="transition-all duration-200 ease-out"
                enter-from-class="translate-y-1 opacity-0"
                enter-to-class="translate-y-0 opacity-100"
                leave-active-class="transition duration-150 ease-in"
                leave-from-class="translate-y-0 opacity-100"
                leave-to-class="translate-y-1 opacity-0"
            >
                <!-- on a phone the panel spans the screen (1rem margins) instead of starting at the
                     button and running off the right edge; long content scrolls inside.
                     z-30: inputs and checkboxes of the page (z-10, later in the DOM) showed through -->
                <PopoverPanel
                    class="absolute z-30 mt-3 w-screen xs:fixed xs:inset-x-4 xs:w-auto xs:!max-w-none xs:max-h-[75vh] xs:overflow-y-auto xs:rounded-lg"
                    :class="[
                        props.size === 'sm' && 'max-w-[240px]',
                        props.size === 'md' && 'max-w-xs',
                        props.size === '2md' && 'max-w-2xl',
                        props.size === 'lg' && 'max-w-lg',
                        props.orientation === 'start' && '-start-3',
                        props.orientation === 'end' && '-end-3',
                        props.class
                    ]"
                    v-slot="{close}"
                >
                    <div
                        class="border-muted-200 after:border-muted-200 dark:border-muted-700 dark:bg-muted-800 dark:after:border-muted-700 dark:after:bg-muted-800 shadow-muted-300/30 dark:shadow-muted-800/20 relative w-full rounded-lg border bg-white shadow-xl after:absolute after:-top-2 after:h-4 after:w-4 after:rotate-[-135deg] after:border-b after:border-r after:bg-white after:content-['']"
                        :class="[
                            props.orientation === 'start' && 'after:start-6',
                            props.orientation === 'end' && 'after:end-6',
                        ]"
                    >
                        <slot name="content" :close="close"></slot>
                    </div>
                </PopoverPanel>
            </Transition>
        </Popover>
    </div>
</template>
