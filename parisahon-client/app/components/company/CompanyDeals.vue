<template>
    <section class="flex flex-col gap-2">
        <template v-if="loading && !deals.length">
            <BasePlaceload v-for="n in 3" :key="n" class="h-12 w-full rounded-md" />
        </template>
        <template v-else>
            <p v-if="deals.length" class="text-xs text-muted-500 dark:text-muted-400">
                {{ deals.length }} {{ russianDecline(deals.length, 'сделка', 'сделки', 'сделок') }}<template v-if="openCount">, в работе {{ openCount }}</template><template v-if="wonCount">, успешных {{ wonCount }} на сумму <Money :value="wonBudget" class="font-medium text-muted-700 dark:text-muted-200" /></template>
                <span class="block text-muted-400">Свои сделки компании и сделки её контактов.</span>
            </p>
            <DealMiniList :deals="deals" :limit="20" show-contacts empty="У компании и её контактов сделок нет" />
        </template>
    </section>
</template>

<script lang="ts" setup>
/** Tab "Сделки" of a company: GET /companies/:id/deals (its own deals and its contacts'), refreshed live. */
import Money from '~/components/common/Money.vue';
import DealMiniList, { type MiniDeal } from '~/components/deal/DealMiniList.vue';
import { promiseResult } from '~/utils/result';
import { russianDecline } from '~/utils/text';

const props = defineProps<{ companyId?: number | string }>();

const companiesService = useService('companies', { auth: true });
const deals = ref<MiniDeal[]>([]);
const loading = ref(false);

const openCount = computed(() => deals.value.filter((d) => !d.closed_at).length);
// successful orders only (the API marks them: closed in the successful stage)
const wonCount = computed(() => deals.value.filter((d) => d.won).length);
const wonBudget = computed(() => deals.value.filter((d) => d.won).reduce((sum, d) => sum + Number(d.budget || 0), 0));

async function load() {
    if (!props.companyId) return;
    loading.value = true;
    const result = await promiseResult(companiesService.get(`${props.companyId}/deals`).exec());
    loading.value = false;
    if (result.ok) deals.value = result.value as MiniDeal[];
}

useLive((changes) => {
    if (liveTouches(changes, 'deals') || liveTouches(changes, 'companies', props.companyId)) load();
}, 1500);

watch(() => props.companyId, load);
onMounted(load);
</script>
