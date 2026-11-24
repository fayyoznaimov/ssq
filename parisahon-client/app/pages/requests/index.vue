<template>
    <div />
</template>

<script lang="ts" setup>
/**
 * «Лог действий» was a page without an API behind it (Feathers-style /requests, it always failed;
 * AUDIT-17). The address leads to the journal of the CRM, «История событий» (admin and manager;
 * everybody else gets «Доступ запрещён» there): the events and the journal of changes (audit_log) together.
 */
definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'История событий',
    middleware: [() => navigateTo('/analytics/events', { replace: true })],
});
</script>
