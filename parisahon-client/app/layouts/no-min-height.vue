<template>
    <TairoCollapseLayout v-if="rerender" :min-height="false" :wrapper-padding="false">
        <slot />
        <Toast id="GlobalToast" />
        <template #toolbar-title>
            Parisa CRM
        </template>
    </TairoCollapseLayout>
</template>

<script lang="ts" setup>
import Toast from '~/components/common/Toast.vue';
import TairoCollapseLayout from '~/components/tairo/TairoCollapseLayout.vue';

const rerender = ref(false);

onMounted(async () => {
    await nextTick();
    rerender.value = true;
});
</script>
