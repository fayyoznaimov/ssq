<template>
    <Single />
</template>

<script lang="ts" setup>
import Single from '~/components/deal/single.vue';

definePageMeta({
    authRoute: true,
    layout: 'no-min-height',
    verbose: 'Добавить сделку',
    subject: 'Deal'
});

useHead({
    title: 'Добавить сделку'
});

</script>