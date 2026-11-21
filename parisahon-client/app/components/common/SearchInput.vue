<template>
    <BaseInput
        v-model="search"
        :classes="{wrapper: 'w-full'}"
        icon="ph:list-magnifying-glass"
        placeholder="Поиск"
        size="lg"
    />
</template>

<script lang="ts" setup>
import { debounce as deb } from "~/utils/search";

interface Props {
    modelValue: string;
    debounce?: number;
}
const props = withDefaults(
    defineProps<Props>(), {
        debounce: 300
    }
);

interface Emits {
    (e: "update:modelValue", value?: string): void;
}

const emit = defineEmits<Emits>();

const update = () => {
    emit("update:modelValue", search.value);
};

const search = ref(props.modelValue);

watch(search, 
    deb(update, props.debounce)
);
</script>
