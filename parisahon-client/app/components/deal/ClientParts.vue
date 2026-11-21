<template>
    <span class="min-w-0 leading-snug">
        <span
            v-if="badge && deal.repeat_of"
            class="mr-1.5 inline-block rounded-full bg-amber-100 px-1.5 align-middle text-[10px] font-semibold uppercase leading-4 tracking-wide text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
            :title="'Повторное обращение, предыдущая сделка №' + (deal.repeat_of.display_id ?? '')"
        >повторный</span>
        <template v-if="parts.name || parts.phone || parts.company">
            <span v-if="parts.name" class="font-medium text-muted-900 dark:text-white">{{ parts.name }}</span>
            <span v-if="parts.more" class="text-muted-400"> +{{ parts.more }}</span>
            <span v-if="parts.phone" class="ml-1.5 whitespace-nowrap font-mono text-[0.92em] text-muted-500 dark:text-muted-400">{{ parts.phone }}</span>
            <span v-if="parts.company" class="ml-1.5 text-primary-600 dark:text-primary-300">{{ parts.company }}</span>
        </template>
        <span v-else-if="empty" class="text-muted-400">{{ empty }}</span>
    </span>
</template>

<script lang="ts" setup>
/**
 * The client of a deal in parts: name (plain), phone (muted, monospace), company (primary)
 * and the amber "повторный" badge of a repeat request. Deals list and kanban cards.
 */
const props = withDefaults(defineProps<{ deal: Record<string, any>; badge?: boolean; empty?: string }>(), {
    badge: true,
    empty: '',
});

const parts = computed(() => clientParts(props.deal));
</script>

<script lang="ts">
/** name / phone / company of a deal's client: its first contact and its company (or the contact's) */
export function clientParts(deal: Record<string, any>) {
    const contacts: any[] = deal?.ctr_agents ?? deal?.contacts ?? [];
    const contact = contacts[0];
    return {
        name: (contact?.username as string) || '',
        phone: (contact?.phone as string) || '',
        company: (deal?.company?.name || contact?.company?.name || '') as string,
        more: Math.max(0, contacts.length - 1),
    };
}

/**
 * true when the deal is still named after its client ("Имя · +998… · Компания", as deals
 * from Telegram / WhatsApp are): then the parts can stand in for the name.
 */
export function isClientLabel(deal: Record<string, any>) {
    const { name, phone, company } = clientParts(deal);
    const label = String(deal?.label ?? '').trim();
    if (!label || !(name || phone)) return false;
    const variants = [[name, phone, company], [name, phone], [name, company], [name], [phone]]
        .map((p) => p.filter(Boolean).join(' · '))
        .filter(Boolean);
    return variants.includes(label);
}
</script>
