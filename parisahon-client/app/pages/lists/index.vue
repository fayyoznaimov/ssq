<template>
    <div></div>
</template>
<script lang="ts" setup>
definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Списки'
});

useHead({
    title: 'Списки'
});

// the crumb «Списки» opened an empty page: the first list is the companies
navigateTo('/lists/companies', { replace: true });
</script>
