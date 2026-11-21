<template>
    <div class="flex flex-col gap-5">
        <nuxt-page></nuxt-page>
    </div>
</template>

<script setup lang="ts">

definePageMeta({
    layout: 'account',
    verbose: 'Аналитика'
});

useHead({
    title: ''
});
</script>

<style scoped>

</style>
