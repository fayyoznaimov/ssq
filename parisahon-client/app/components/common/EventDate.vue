<template>
    <span>{{ new Date(event.created_at).toLocaleString('ru') }}</span>
    <span class="ml-2">{{ event.originated_by?.username ?? "—" }}</span>
</template>

<script setup lang="ts">
import type { DealEvent } from '~/types/deal';
defineProps<{event: DealEvent}>();
</script>
