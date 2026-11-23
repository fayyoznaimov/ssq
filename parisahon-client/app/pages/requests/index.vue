<template>
    <div />
</template>

<script lang="ts" setup>
/**
 * «Лог действий» was a page without an API behind it (Feathers-style /requests, it always failed;
 * AUDIT-17). The address leads to the journal of the CRM, «Список событий» (admin and manager;
 * everybody else gets «Доступ запрещён» there). A journal of every action comes with audit_log.
 */
definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Список событий',
    middleware: [() => navigateTo('/analytics/events', { replace: true })],
});
</script>
