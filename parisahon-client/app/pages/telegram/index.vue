<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Telegram</h1>
            <p class="text-sm text-muted-500">Переписка с клиентами из Telegram менеджеров приходит в их сделки. Подключить можно только свой Telegram.</p>
        </div>

        <!-- the manager's own Telegram: its real state, connect / reconnect / disconnect (like the WhatsApp page) -->
        <BaseCard class="p-6 flex flex-col gap-3 max-w-2xl">
            <div class="flex items-center gap-2">
                <Icon name="ph:telegram-logo" class="size-6 text-sky-500 shrink-0" />
                <h3 class="text-lg">Ваш Telegram</h3>
            </div>
            <p v-if="ownLoading && !own" class="text-sm text-muted-500">Загрузка…</p>
            <template v-else>
                <p class="text-sm" :class="stateClass(own?.state)">{{ own?.text ?? 'Состояние Telegram неизвестно' }}</p>
                <p v-if="ownRow?.telegram?.account || ownRow?.telegram?.last_message_at" class="text-xs text-muted-500">
                    <span v-if="ownRow?.telegram?.account">Аккаунт {{ ownRow.telegram.account }}</span>
                    <span v-if="ownRow?.telegram?.account && ownRow?.telegram?.last_message_at"> · </span>
                    <span v-if="ownRow?.telegram?.last_message_at">последнее сообщение {{ lastMessage(ownRow.telegram.last_message_at) }}</span>
                </p>
                <p v-if="!own || own.state === 'off'" class="text-sm text-muted-500">
                    Как подключить: нажмите «Подключить» — Telegram пришлёт код в приложение Telegram (чат «Telegram»), не по SMS,
                    на номер из вашего профиля{{ user?.phone ? ` (${user.phone})` : '' }}. Введите код (и облачный пароль, если он включён) —
                    после этого переписка с клиентами будет приходить в их сделки, а отвечать можно прямо из сделки.
                </p>
                <p v-else-if="own.state === 'broken'" class="text-sm text-muted-500">
                    Пока это так, сообщения клиентов из вашего Telegram не попадают в CRM и ответить из сделки нельзя. Нажмите «Подключить заново».
                </p>
                <p v-if="!user?.phone" class="text-sm text-amber-600">
                    В профиле не указан номер телефона: укажите его в
                    <NuxtLink to="/profile" class="underline">профиле</NuxtLink>, на него Telegram пришлёт код.
                </p>
                <div class="flex flex-wrap gap-2">
                    <BaseButton
                        v-if="!own || own.state !== 'ok'"
                        color="primary"
                        :loading="sendingCode"
                        :disabled="sendingCode || !user?.phone"
                        @click="onConnect"
                    >
                        {{ own && own.state !== 'off' ? 'Подключить заново' : 'Подключить' }}
                    </BaseButton>
                    <BaseButton
                        v-if="own && own.state !== 'off'"
                        color="danger"
                        variant="pastel"
                        :loading="disconnecting === user.id"
                        @click="onDisconnect(user.id)"
                    >
                        Отключить
                    </BaseButton>
                    <BaseButton v-if="own && own.state !== 'ok' && own.state !== 'off'" variant="pastel" :loading="ownLoading" @click="load">Проверить снова</BaseButton>
                </div>
            </template>
        </BaseCard>

        <MessengerFilters channel="telegram" />

        <!-- the staff's accounts: for the admin and the managers (the API gives an agent only their own) -->
        <div v-if="isManager" class="flex flex-col gap-3">
            <h2 class="text-lg">Telegram сотрудников</h2>
            <p v-if="sessionsError" class="text-sm text-red-500">{{ sessionsError }}</p>
            <p v-else-if="sessionsLoading && !sessions.length" class="text-sm text-muted-500">Загрузка…</p>
            <p v-else-if="!sessions.length" class="text-sm text-muted-500">Пока никто не подключил Telegram.</p>
            <ul v-else class="divide-y divide-muted-200 dark:divide-muted-700 max-w-3xl">
                <li v-for="s in sessions" :key="s.id" class="py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
                    <span class="min-w-0 truncate">{{ s.username || `#${s.id}` }}</span>
                    <span class="text-muted-500">{{ s.telegram?.account ?? s.phone ?? '' }}</span>
                    <span class="grow text-end" :class="stateClass(s.telegram?.state)">
                        {{ s.telegram?.text ?? '' }}{{ s.telegram?.last_message_at ? ` · ${lastMessage(s.telegram.last_message_at)}` : '' }}
                    </span>
                    <BaseButton
                        v-if="s.id === user.id || isAdmin"
                        size="sm"
                        color="danger"
                        variant="pastel"
                        :loading="disconnecting === s.id"
                        @click="onDisconnect(s.id)"
                    >
                        Отключить
                    </BaseButton>
                </li>
            </ul>
        </div>
        <TelegramConfirmation :phone="codePhone" @confirmed="onConfirmed" />
    </div>
</template>

<script lang="ts" setup>
import TelegramConfirmation from '~/components/modals/TelegramConfirmation.vue';
import MessengerFilters from '~/components/whatsapp/MessengerFilters.vue';
import { type User, UserRole } from '~/types/user';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Телеграм',
    subject: 'Telegram'
});

useHead({
    title: 'Телеграм'
});

// the session states come from the Telegram service: connected / error / revoked (ended in Telegram itself)
type Health = { state: 'ok' | 'connecting' | 'broken' | 'off' | 'unknown'; text: string; since?: string | null; phone?: string | null };
type SessionRow = User & { telegram?: Health & { account?: string | null; last_message_at?: number | null } };

const toast = useToast('GlobalToast');
const user = useState<User>('user');
const isAdmin = computed(() => user.value?.role === UserRole.Admin);
const isManager = computed(() => user.value?.role === UserRole.Admin || user.value?.role === UserRole.Manager);
const telegramConfirmation = useModal('TelegramConfirmation');
const telegramService = useService('telegram', {auth: true});
const messengerService = useService('messenger', {auth: true});
const sessions = ref<SessionRow[]>([]);
const sessionsLoading = ref(false);
const sessionsError = ref('');
const {isLoading: sendingCode, runAsync} = useAsync();
const own = ref<Health | null>(null);
const ownLoading = ref(true);
const codePhone = ref('');
const disconnecting = ref<number | null>(null);
// the own row of GET /telegram/active-sessions: the account (@username / phone) and the last message
const ownRow = computed(() => sessions.value.find((s) => s.id === user.value?.id) ?? null);

function stateClass(state?: string) {
    if (state === 'ok') return 'text-emerald-600 dark:text-emerald-400';
    if (state === 'broken') return 'text-red-500';
    if (state === 'connecting' || state === 'unknown') return 'text-amber-600';
    return 'text-muted-500';
}

function lastMessage(at?: number | null) {
    if (!at) return '';
    return new Date(at * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function onConnect() {
    // own account only; the Telegram application keys are on the server
    const result = await promiseResult(runAsync(telegramService.post('/send-code', {
        user_id: user.value.id,
    }).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 6000});
    codePhone.value = (result.value as any)?.phone ?? '';
    telegramConfirmation.open();
}

async function onDisconnect(id: number) {
    const whose = id === user.value.id ? 'ваш Telegram' : 'Telegram этого сотрудника';
    if (!confirm(`Отключить ${whose} от CRM? Сеанс завершится и в самом Telegram, сообщения клиентов перестанут приходить в сделки.`)) return;
    disconnecting.value = id;
    const result = await promiseResult(telegramService.remove(id === user.value.id ? 'session' : `session?user_id=${id}`).exec());
    disconnecting.value = null;
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 6000});
    toast.show({message: 'Telegram отключён от CRM', type: 'success', timeout: 3000});
    load();
}

async function fetchSessions() {
    sessionsLoading.value = true;
    const result = await promiseResult(telegramService.get<SessionRow[]>('active-sessions').exec());
    sessionsLoading.value = false;
    if (result.ok) {
        sessions.value = Array.isArray(result.value) ? result.value : [];
        sessionsError.value = '';
    } else {
        sessionsError.value = (result.error as any)?.data?.message || result.error?.message || 'Telegram-сервис недоступен';
    }
}

async function fetchOwn() {
    ownLoading.value = true;
    const result = await promiseResult(messengerService.get<{ telegram: Health }>('status').exec());
    ownLoading.value = false;
    own.value = result.ok ? result.value.telegram : null;
}

function load() {
    fetchSessions();
    fetchOwn();
}

function onConfirmed() {
    load();
    // the listener takes the new session within a few seconds
    setTimeout(load, 5000);
}

onMounted(load);

</script>
