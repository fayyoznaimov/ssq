<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">WhatsApp</h1>
            <p class="text-sm text-muted-500">Переписка с клиентами из WhatsApp менеджеров приходит в их сделки. Подключить можно только свой WhatsApp.</p>
        </div>
        <WhatsAppConnect />
        <MessengerFilters channel="whatsapp" />
        <div v-if="isAdmin" class="flex flex-col gap-3">
            <h2 class="text-lg">WhatsApp сотрудников</h2>
            <p v-if="sessionsError" class="text-sm text-red-500">{{ sessionsError }}</p>
            <p v-else-if="!sessions.length" class="text-sm text-muted-500">Пока никто не подключил WhatsApp.</p>
            <ul v-else class="divide-y divide-muted-200 dark:divide-muted-700 max-w-3xl">
                <li v-for="s in sessions" :key="s.user_id" class="py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
                    <span class="min-w-0 truncate">{{ s.username || `#${s.user_id}` }}</span>
                    <span class="text-muted-500">{{ s.phone || '' }}</span>
                    <span class="grow text-end" :class="stateClass(s)">{{ s.text || statusLabel[s.status] || s.status }}</span>
                    <BaseButton
                        v-if="s.status !== 'none'"
                        size="sm"
                        color="danger"
                        variant="pastel"
                        :loading="disconnecting === s.user_id"
                        @click="disconnect(s)"
                    >
                        Отключить
                    </BaseButton>
                </li>
            </ul>
        </div>
    </div>
</template>

<script lang="ts" setup>
import MessengerFilters from '~/components/whatsapp/MessengerFilters.vue';
import WhatsAppConnect from '~/components/whatsapp/WhatsAppConnect.vue';
import { type User, UserRole } from '~/types/user';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'WhatsApp',
    subject: 'WhatsApp'
});

useHead({ title: 'WhatsApp' });

// GET /whatsapp/sessions: every staff user with the state of their number (text: in words)
type Session = { user_id: number; username?: string; status: string; phone?: string | null; text?: string; state?: string };
const statusLabel: Record<string, string> = { connected: 'Подключён', starting: 'Подключается', qr: 'Ждёт QR', code: 'Ждёт код', logged_out: 'Отвязан на телефоне', none: 'Не подключён' };

const user = useState<User>('user');
const isAdmin = computed(() => user.value?.role === UserRole.Admin);
const service = useService('whatsapp', { auth: true });
const toast = useToast('GlobalToast');
const sessions = ref<Session[]>([]);
const sessionsError = ref('');
const disconnecting = ref<number | null>(null);

function stateClass(s: Session) {
    if (s.state === 'ok' || s.status === 'connected') return 'text-emerald-600 dark:text-emerald-400';
    if (s.state === 'broken') return 'text-red-500';
    if (s.state === 'off' || s.status === 'none') return 'text-muted-500';
    return 'text-amber-600';
}

async function load() {
    if (!isAdmin.value) return;
    try {
        const list = await service.get<Session[]>('sessions').exec();
        sessions.value = Array.isArray(list) ? list : [];
        sessionsError.value = '';
    } catch (e: any) {
        sessionsError.value = e?.data?.message || e?.message || 'WhatsApp-сервис недоступен';
    }
}

async function disconnect(s: Session) {
    if (!confirm(`Отключить WhatsApp сотрудника «${s.username || s.user_id}» от CRM? Устройство отвяжется на его телефоне.`)) return;
    disconnecting.value = s.user_id;
    try {
        await service.remove(s.user_id === user.value.id ? 'session' : `session?user_id=${s.user_id}`).exec();
        toast.show({ type: 'success', message: 'WhatsApp отключён от CRM', timeout: 3000 });
        await load();
    } catch (e: any) {
        toast.show({ type: 'error', message: e?.data?.message || e?.message || 'Не удалось отключить', timeout: 6000 });
    } finally {
        disconnecting.value = null;
    }
}

onMounted(load);
</script>
