<template>
    <!-- one line on a phone too («25 | На / страницу» took two) -->
    <div class="flex shrink-0 whitespace-nowrap" title="Строк на странице">
        <BaseButton class="flex items-center !px-3 !rounded-r-none !border-e-0">
            {{ props.modelValue }}
        </BaseButton>
        <BaseDropdown
            class="per-page-select [&_button]:whitespace-nowrap"
            flavor="button"
            :label="isPhone ? 'на стр.' : 'На страницу'"
            orientation="start"
        >
            <BaseDropdownItem
                v-for="option in options"
                :key="option"
                :title="option.toString()"
                @click="emit('update:modelValue', option)"
            />
        </BaseDropdown>
    </div>
</template>

<script lang="ts" setup>
import { useMediaQuery } from '@vueuse/core';

const props = defineProps<{ modelValue: number }>();
const emit = defineEmits(['update:modelValue']);
const options = [10, 25, 50, 100];
const isPhone = useMediaQuery('(max-width: 639px)');
</script>

<style lang="scss">
.per-page-select {
    button {
        border-top-left-radius: 0 !important;
        border-bottom-left-radius: 0 !important;
    }
}
</style>
