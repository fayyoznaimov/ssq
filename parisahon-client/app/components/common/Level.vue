<template>
    <form @submit.prevent @change="update" class="h-full grid grid-rows-4 gap-0.5">
        <BaseRadio
            v-for="(index) in getIndexes()"
            :key="index"
            :value="`${index}`"
            :label="`${index}`"
            :checked="props.level == index"
            :name="`${permission}-${actionKey}`"
            :id="`${permission}-${actionKey}-${index}`"
            :color="colors[index]"
            :classes="{ wrapper: `row-start-${index + 1} row-end-${index + 2}` }"
        />
    </form>
</template>
<script lang="ts" setup>
const props = defineProps<{
    level: number;
    actionKey: string;
    permission: string;
}>();

const emit = defineEmits(['update:value']);

const colors = [
    'danger',
    'default',
    'warning',
    'info',
];

function getIndexes() {
    if(props.permission === 'create') {
        return [0, 3];
    }
    return [0, 1 ,2, 3];
}

function update(event: Event) {
    emit('update:value', +event.target.value);
}
</script>

<style scoped>
.row-start-1 {
    grid-row-start: 1;
}

.row-start-2 {
    grid-row-start: 2;
}

.row-start-3 {
    grid-row-start: 3;
}

.row-start-4 {
    grid-row-start: 4;
}

.row-start-5 {
    grid-row-start: 5;
}

.row-start-6 {
    grid-row-start: 6;
}

.row-start-7 {
    grid-row-start: 7;
}
</style>
```
