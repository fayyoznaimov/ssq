<template>
    <TairoCollapseLayout v-if="rerender" :min-height="false" :wrapper-padding="false">
        <slot />
        <Toast id="GlobalToast" />
        <template #toolbar-title>
            {{ pageTitle }}
        </template>
    </TairoCollapseLayout>
</template>

<script lang="ts" setup>
import Toast from '~/components/common/Toast.vue';
import TairoCollapseLayout from '~/components/tairo/TairoCollapseLayout.vue';

// the header names the page («Сделки», the name of an open company), not the CRM; a page without a title
// of its own gets it in the tab too (its own useHead comes later and wins)
const pageTitle = usePageTitle();
useHead({ title: pageTitle });

const rerender = ref(false);

onMounted(async () => {
    await nextTick();
    rerender.value = true;
});
</script>
