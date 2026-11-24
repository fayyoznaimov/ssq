<template>
    <section class="rounded-lg border border-muted-200 bg-white p-3 dark:border-muted-700 dark:bg-muted-800">
        <header class="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold uppercase tracking-wide text-muted-400">Клиент</span>
            <NuxtLink
                v-if="history?.repeat_of"
                :to="`/deals/${history.repeat_of.id}`"
                class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 hover:underline dark:bg-amber-500/20 dark:text-amber-300"
                :title="'Предыдущая сделка: ' + (history.repeat_of.label || '')"
            >
                <Icon name="ph:arrow-counter-clockwise" class="size-3.5" />
                Повторное обращение · №{{ history.repeat_of.display_id }}
            </NuxtLink>
        </header>

        <BasePlaceload v-if="!history" class="h-10 w-full rounded-md" />
        <template v-else>
            <div v-for="contact in history.contacts" :key="contact.id" class="flex items-center gap-3 py-1">
                <BaseAvatar
                    :text="contact.username?.slice(0, 2)"
                    :src="contact.avatar ? uploadUrl(contact.avatar) : undefined"
                    size="sm"
                    class="shrink-0 bg-primary-400 text-white"
                />
                <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 items-center gap-1.5">
                        <NuxtLink :to="`/lists/contacts/${contact.id}`" class="truncate font-medium text-muted-900 hover:underline dark:text-white">{{ contact.username }}</NuxtLink>
                        <Icon v-if="contact.tg_id" name="ph:telegram-logo" class="size-4 shrink-0 text-sky-500" title="Есть Telegram" />
                        <Icon v-if="contact.wa_id" name="ph:whatsapp-logo" class="size-4 shrink-0 text-emerald-500" title="Есть WhatsApp" />
                    </div>
                    <div class="flex flex-wrap items-center gap-x-3 text-xs">
                        <a v-if="contact.phone" :href="'tel:' + contact.phone.replace(/[^\d+]/g, '')" class="font-mono text-muted-500 hover:text-primary-500 dark:text-muted-400">{{ contact.phone }}</a>
                        <NuxtLink
                            v-if="contact.company || history.company"
                            :to="`/lists/companies/${(contact.company || history.company)!.id}`"
                            class="inline-flex min-w-0 items-center gap-1 text-primary-600 hover:underline dark:text-primary-300"
                        >
                            <Icon name="ph:buildings" class="size-3.5 shrink-0" />
                            <span class="truncate">{{ (contact.company || history.company)!.name }}</span>
                        </NuxtLink>
                    </div>
                </div>
            </div>
            <NuxtLink
                v-if="!history.contacts.length && history.company"
                :to="`/lists/companies/${history.company.id}`"
                class="flex items-center gap-2 py-1 text-sm text-primary-600 hover:underline dark:text-primary-300"
            >
                <Icon name="ph:buildings" class="size-4" />
                {{ history.company.name }}
            </NuxtLink>
            <p v-if="!history.contacts.length && !history.company" class="py-1 text-xs text-muted-400">
                Клиент не указан: добавьте контакт или компанию в форме.
            </p>

            <div v-if="history.deals.length" class="mt-2 border-t border-muted-200 pt-2 dark:border-muted-700">
                <p class="mb-1 text-xs text-muted-500 dark:text-muted-400">
                    <span class="font-medium text-muted-700 dark:text-muted-200">
                        {{ history.totals.count }} {{ russianDecline(history.totals.count, 'другой заказ', 'других заказа', 'других заказов') }}</span><template v-if="history.totals.won">, успешных {{ history.totals.won }} на сумму
                        <Money :value="history.totals.won_budget" class="font-medium text-muted-700 dark:text-muted-200" /></template><template v-if="history.totals.closed - history.totals.won > 0">, без результата {{ history.totals.closed - history.totals.won }}</template><template v-if="history.totals.open">, в работе {{ history.totals.open }}</template>
                </p>
                <DealMiniList :deals="history.deals" :limit="3" />
            </div>
            <p v-else-if="history.contacts.length || history.company" class="mt-1 text-xs text-muted-400">Других сделок у клиента нет.</p>
        </template>
    </section>
</template>

<script lang="ts" setup>
/**
 * "Клиент" at the top of the deal card: who the client is (avatar, name, phone,
 * company, Telegram / WhatsApp), whether this is a repeat request, and the client's
 * other deals with the totals. GET /deals/:id/client-history, refreshed live.
 */
import Money from '~/components/common/Money.vue';
import { uploadUrl } from '~/utils/files';
import { promiseResult } from '~/utils/result';
import { russianDecline } from '~/utils/text';

import DealMiniList, { type MiniDeal } from './DealMiniList.vue';

type NamedRef = { id: number; name: string };
type ClientHistory = {
    contacts: {
        id: number;
        username: string;
        phone: string | null;
        email: string | null;
        avatar: string | null;
        tg_id: string | null;
        wa_id: string | null;
        company: NamedRef | null;
    }[];
    company: NamedRef | null;
    repeat_of: { id: number; display_id: number; label: string } | null;
    deals: (MiniDeal & { company: NamedRef | null })[];
    totals: { count: number; open: number; closed: number; won: number; won_budget: number };
};

const props = defineProps<{ dealId: number | string }>();

const dealService = useService('deals', { auth: true });
const history = ref<ClientHistory | null>(null);

async function load() {
    if (!props.dealId) return;
    const result = await promiseResult(dealService.get(`${props.dealId}/client-history`).exec());
    if (result.ok) history.value = result.value as ClientHistory;
}

// the client's other deals change elsewhere (a stage, a new deal from Telegram / WhatsApp),
// a contact or company added to this deal comes as its event
useLive((changes) => {
    if (liveTouches(changes, 'deals') || liveTouches(changes, 'events', props.dealId)) load();
}, 1500);

watch(() => props.dealId, () => {
    history.value = null;
    load();
});

onMounted(load);
</script>
