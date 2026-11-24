<template>
    <div>
        <p v-if="!deals.length" class="py-2 text-sm text-muted-400">{{ empty }}</p>
        <ul v-else class="-mx-2 flex flex-col">
            <li v-for="deal in shown" :key="deal.id">
                <NuxtLink
                    :to="`/deals/${deal.id}`"
                    class="block rounded-md px-2 py-2 transition-colors hover:bg-muted-100 dark:hover:bg-muted-700/60"
                >
                    <div class="flex min-w-0 items-baseline gap-2">
                        <span class="shrink-0 font-mono text-xs text-muted-400">№{{ deal.display_id }}</span>
                        <span class="min-w-0 flex-1 break-words text-sm leading-snug text-primary-600 line-clamp-2 dark:text-primary-300">{{ deal.label || 'Без названия' }}</span>
                        <span class="shrink-0 text-xs text-muted-400" :title="'Создана ' + formatDate(deal.created_at, 'DD.MM.YYYY HH:mm')">{{ formatDate(deal.created_at, 'DD.MM.YY') }}</span>
                    </div>
                    <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-500 dark:text-muted-400">
                        <StageChip :stage="deal.stage" class="max-w-[12rem]" />
                        <Money :value="Number(deal.budget || 0)" class="font-medium text-muted-800 dark:text-muted-100" />
                        <span v-if="deal.agent" class="inline-flex min-w-0 items-center gap-1">
                            <Icon name="ph:user-circle" class="size-3.5 shrink-0" />
                            <span class="truncate">{{ deal.agent.username }}</span>
                        </span>
                        <span v-if="deal.closed_at" class="text-muted-400">закрыта {{ formatDate(deal.closed_at, 'DD.MM.YY') }}</span>
                    </div>
                    <div v-if="showContacts && contactsOf(deal).length" class="mt-1 flex flex-wrap gap-x-3 text-xs">
                        <span v-for="c in contactsOf(deal)" :key="c.id" class="inline-flex min-w-0 items-center gap-1">
                            <span class="text-muted-700 dark:text-muted-200">{{ c.username }}</span>
                            <span v-if="c.phone" class="font-mono text-muted-400">{{ c.phone }}</span>
                        </span>
                    </div>
                </NuxtLink>
            </li>
        </ul>
        <button
            v-if="hidden > 0 || expanded"
            type="button"
            class="mt-1 rounded px-1 py-1 text-xs font-medium text-primary-600 hover:underline dark:text-primary-300"
            @click="expanded = !expanded"
        >
            {{ expanded ? 'свернуть' : `ещё ${hidden}` }}
        </button>
    </div>
</template>

<script lang="ts" setup>
/**
 * A compact list of deals: number, name, date, stage chip, budget, responsible
 * (and the contacts), every row a link to the deal. Used by the "Клиент" block of the
 * deal card, the "Сделки" tab of a company and of a contact.
 */
import { formatDateAs } from '~/utils/format';

import Money from '~/components/common/Money.vue';

import StageChip from './StageChip.vue';

export type MiniDeal = {
    id: number;
    display_id: number;
    label: string;
    budget: number | string | null;
    created_at: string;
    closed_at?: string | null;
    won?: boolean;
    stage?: { id: number; name: string; color?: string | null } | null;
    agent?: { id: number; username: string } | null;
    contacts?: { id: number; username: string; phone?: string | null }[];
    ctr_agents?: { id: number; username: string; phone?: string | null }[];
};

const props = withDefaults(defineProps<{
    deals: MiniDeal[];
    /** show only the newest N, the rest behind "ещё N" */
    limit?: number;
    showContacts?: boolean;
    empty?: string;
}>(), {
    limit: 0,
    showContacts: false,
    empty: 'Сделок нет',
});

const expanded = ref(false);
const shown = computed(() => (props.limit && !expanded.value ? props.deals.slice(0, props.limit) : props.deals));
const hidden = computed(() => (props.limit ? Math.max(0, props.deals.length - props.limit) : 0));

function contactsOf(deal: MiniDeal) {
    return deal.contacts ?? deal.ctr_agents ?? [];
}

// the one date format of the CRM (utils/format.ts): «21 нояб. 2026», with the time on hover
function formatDate(value: string | null | undefined, format: string) {
    return formatDateAs(value, format, '');
}
</script>
