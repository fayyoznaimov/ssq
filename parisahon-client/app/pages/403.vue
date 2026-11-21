<template>
    <div class="flex flex-col gap-5">
        <div>
            Доступ запрещён
        </div>
    </div>
</template>
<script lang="ts" setup>
definePageMeta({
    layout: 'account',
    verbose: 'Доступ запрещен'
});

useHead({
    title: 'Доступ запрещен'
});
</script>
