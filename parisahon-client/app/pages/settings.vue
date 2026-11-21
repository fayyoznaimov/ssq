<template>
    <div class="flex flex-col gap-5">
        <nuxt-page></nuxt-page>
    </div>
</template>

<script setup lang="ts">

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Настройки',
    subject: 'Settings'
});

useHead({
    title: ''
});
</script>

<style scoped>

</style>
