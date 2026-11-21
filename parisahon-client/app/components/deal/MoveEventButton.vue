<script setup lang="ts">
// "Перенести в другую сделку" for a Telegram message or an email in the history of a deal:
// PATCH /deals/events/remap {event_id, replace_with_deal_id}; the files of the message
// move with it. The API checks that the user may change both deals.
import type { Deal, DealEvent } from '~/types/deal';

const props = defineProps<{ event: DealEvent; dealId: number }>();
const emits = defineEmits<{ (e: 'moved', target: Deal): void }>();

const dealService = useService('deals', { auth: true });
const toast = useToast('GlobalToast');
const open = ref(false);
const query = ref('');
const results = ref<Deal[]>([]);
const searching = ref(false);
const moving = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function search() {
    const q = query.value.trim();
    searching.value = true;
    try {
        const params: Record<string, any> = { limit: 8, sort: { id: -1 } };
        if (/^\d+$/.test(q)) params.display_id = Number(q);
        else if (q) params.label = q;
        const res: any = await dealService.find(params).exec();
        results.value = (res?.data ?? res ?? []).filter((d: Deal) => d.id !== props.dealId);
    } catch {
        results.value = [];
    } finally {
        searching.value = false;
    }
}

watch(query, () => {
    clearTimeout(timer);
    timer = setTimeout(search, 300);
});

function toggle() {
    open.value = !open.value;
    if (open.value && !results.value.length) search();
}

async function move(target: Deal) {
    if (!confirm(`Перенести в сделку №${target.display_id ?? target.id} «${target.label || ''}»?`)) return;
    moving.value = true;
    try {
        await dealService.patch('events/remap', { event_id: props.event.id, replace_with_deal_id: target.id }).exec();
        toast.show({ message: `Перенесено в сделку №${target.display_id ?? target.id}`, timeout: 3000, type: 'success' });
        open.value = false;
        emits('moved', target);
    } catch (e: any) {
        toast.show({ message: e?.message || 'Не удалось перенести', timeout: 4000, type: 'error' });
    } finally {
        moving.value = false;
    }
}
</script>

<template>
    <div class="relative inline-block">
        <button type="button" class="text-[13px] text-muted-500 hover:text-primary-600 dark:text-muted-400 dark:hover:text-primary-300 inline-flex items-center gap-1"
                title="Перенести в другую сделку" @click="toggle">
            <Icon name="ph:arrow-bend-up-right" class="size-4" />
            <span>Перенести</span>
        </button>
        <div v-if="open" class="absolute left-0 z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-muted-200 bg-white p-2 shadow-lg dark:border-muted-700 dark:bg-muted-800">
            <BaseInput v-model="query" size="sm" placeholder="Название или номер сделки" autofocus />
            <p v-if="searching && !results.length" class="px-1 py-2 text-sm text-muted-500">Поиск…</p>
            <p v-else-if="!results.length" class="px-1 py-2 text-sm text-muted-500">Сделки не найдены</p>
            <ul v-else class="mt-1 max-h-60 overflow-y-auto">
                <li v-for="d in results" :key="d.id">
                    <button type="button" :disabled="moving" class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted-100 dark:hover:bg-muted-700 disabled:opacity-50" @click="move(d)">
                        <span class="text-muted-500">№{{ d.display_id ?? d.id }}</span>
                        {{ d.label || 'Без названия' }}
                        <span v-if="d.company?.name" class="block text-[12px] text-muted-500 truncate">{{ d.company.name }}</span>
                    </button>
                </li>
            </ul>
        </div>
    </div>
</template>
