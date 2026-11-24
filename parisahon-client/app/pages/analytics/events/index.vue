<template>
    <div class="flex flex-col gap-6">
        <div>
            <h1 class="text-xl">История событий</h1>
            <h2 class="text-sm text-muted-500 dark:text-muted-400">
                Кто, когда и откуда что сделал в CRM: события сделок и все изменения данных — карточек, прав, настроек, входы
            </h2>
            <!-- /analytics/events?deal_id=12: the history of one deal -->
            <p v-if="dealId" class="mt-2 flex items-center gap-2 text-sm text-muted-600 dark:text-muted-300">
                <span>Только сделка № {{ dealId }}</span>
                <BaseButton size="sm" @click="dealId = null">Все сделки</BaseButton>
            </p>
        </div>
        <HistoryJournal v-model:deal-id="dealId" />
    </div>
</template>

<script lang="ts" setup>
/**
 * «История событий» (it was «Список событий» over GET /logs): one history of the CRM in which the business
 * events (messages, calls, letters, notes, tasks, stages) and the journal of changes of data (src/audit: who
 * changed what, when and from where — a person, the bot, a trigger, the autopilot, the receivers) live
 * together, with filters (components/audit/HistoryJournal.vue, GET /audit). Admin and manager; /requests
 * («Лог действий») leads here. The cards of a deal, a company, a contact and an employee show the same view
 * of their own records (components/audit/CardHistory.vue).
 */
import HistoryJournal from '~/components/audit/HistoryJournal.vue';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'История событий',
});

useHead({
    title: 'История событий',
});

const route = useRoute();
const router = useRouter();
// one deal's history (the API filters by deal_id); dropping the filter drops it from the address too
const dealId = ref<number | null>(Number(route.query.deal_id) > 0 ? Number(route.query.deal_id) : null);
watch(dealId, (value) => {
    router.replace({ query: { ...route.query, deal_id: value ? String(value) : undefined, page: undefined } }).catch(() => undefined);
});
</script>
