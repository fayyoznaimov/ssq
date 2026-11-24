<script setup lang="ts">
// Under the composer of a deal, for Telegram / WhatsApp: from which account the message goes and
// whether it works now (GET /messenger/status), a warning in another manager's deal, and «Не клиент»
// for the chosen contact (POST /messenger/ignored: the chats with this person stop coming into the CRM).
// `blocked` (emitted): the manager's own Telegram / WhatsApp is not connected or was ended on the phone — the
// deal form keeps the text and does not send (OMNI-9); the state is asked again when the tab gets the focus back.
type Health = { state: 'ok' | 'connecting' | 'broken' | 'off' | 'unknown'; text: string; status?: string; phone?: string | null };
type Status = { telegram: Health; whatsapp: Health };

const props = defineProps<{
    channel: 'tg' | 'wa';
    contact?: { id?: number; username?: string } | null;
    deal?: { id?: number; agent?: { id?: number; username?: string } | null } | null;
}>();

const emit = defineEmits<{ (e: 'blocked', value: boolean): void }>();
const me = useState<any>('user');
const toast = useToast('GlobalToast');
const service = useService('messenger', { auth: true });
// one request per minute for all the deals opened meanwhile
const cache = useState<{ at: number; status: Status | null }>('messenger-status', () => ({ at: 0, status: null }));
const busy = ref(false);

const health = computed<Health | null>(() => {
    const status = cache.value.status;
    if (!status) return null;
    return props.channel === 'tg' ? status.telegram : status.whatsapp;
});
const name = computed(() => (props.channel === 'tg' ? 'Telegram' : 'WhatsApp'));
const foreign = computed(() => {
    const agent = props.deal?.agent;
    return agent?.id && me.value?.id && agent.id !== me.value.id ? agent : null;
});
const stateClass = computed(() => ({
    ok: 'text-emerald-600 dark:text-emerald-400',
    broken: 'text-red-500',
    connecting: 'text-amber-600',
    unknown: 'text-amber-600',
    off: 'text-red-500',
} as Record<string, string>)[health.value?.state ?? ''] ?? 'text-muted-500');

async function load(force = false) {
    if (!force && cache.value.status && Date.now() - cache.value.at < 60_000) return;
    try {
        cache.value = { at: Date.now(), status: await service.get<Status>('status').exec() };
    } catch {
        cache.value = { at: Date.now(), status: null };
    }
}

async function notClient() {
    const contact = props.contact;
    if (!contact?.id) return;
    if (!confirm(`«${contact.username ?? 'Контакт'}» — не клиент? Новые сообщения с ним из Telegram и WhatsApp менеджера сделки не будут попадать в CRM и создавать сделки. Эту сделку закройте или удалите сами. Вернуть можно на странице Telegram или WhatsApp.`)) return;
    busy.value = true;
    try {
        await service.post('ignored', { contact_id: contact.id, deal_id: props.deal?.id }).exec();
        toast.show({ type: 'success', message: 'Отмечено «Не клиент»: его чаты больше не попадают в CRM', timeout: 4000 });
    } catch (e: any) {
        toast.show({ type: 'error', message: e?.data?.message || e?.message || 'Не удалось отметить', timeout: 6000 });
    } finally {
        busy.value = false;
    }
}

// sending cannot work: nothing connected, or the session was ended in Telegram / unlinked on the phone
// (a session that reconnects by itself, or a service that did not answer, does not block)
const blocked = computed(() => {
    const h = health.value;
    if (!h) return false;
    return h.state === 'off' || (h.state === 'broken' && ['revoked', 'logged_out'].includes(h.status ?? ''));
});
watch(blocked, (value) => emit('blocked', value), { immediate: true });

function onFocus() {
    load(true);
}

watch(() => props.channel, () => load());
onMounted(() => {
    load();
    window.addEventListener('focus', onFocus);
});
onBeforeUnmount(() => window.removeEventListener('focus', onFocus));
</script>

<template>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span v-if="health" :class="stateClass">
            <template v-if="blocked">Ваш {{ name }} не подключён к CRM — сообщение не уйдёт.</template>
            <template v-else>С вашего {{ name }}{{ health.phone ? ` ${health.phone}` : '' }}: {{ health.state === 'ok' ? 'подключён' : health.text }}</template>
            <NuxtLink v-if="health.state !== 'ok'" :to="props.channel === 'tg' ? '/telegram' : '/whatsapp'" class="underline">подключить</NuxtLink>
        </span>
        <span v-if="foreign" class="text-amber-600">Сделка менеджера {{ foreign.username || '' }}: клиент получит сообщение с вашего {{ name }}.</span>
        <button v-if="props.contact?.id" type="button" class="text-muted-500 underline disabled:opacity-50" :disabled="busy" @click="notClient">
            Не клиент
        </button>
    </div>
</template>
