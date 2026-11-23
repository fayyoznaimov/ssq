<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
                <h1 class="text-xl">Telegram менеджеров</h1>
                <p class="text-sm text-muted-500">Переписка с клиентами из Telegram менеджеров приходит в их сделки. Подключить можно только свой Telegram: код придёт в Telegram на ваш номер из профиля{{ user?.phone ? ` (${user.phone})` : '' }}.</p>
            </div>
            <BaseButton color="primary" @click="onConnect" :loading="sendingCode" :disabled="sendingCode">
                {{ own && own.state !== 'off' ? 'Подключить заново' : 'Подключить' }}
            </BaseButton>
        </div>
        <BaseCard v-if="own" class="p-4 flex flex-wrap items-center justify-between gap-3 max-w-2xl">
            <div class="flex items-center gap-2 min-w-0">
                <Icon name="ph:telegram-logo" class="size-6 text-sky-500 shrink-0" />
                <span class="text-sm" :class="stateClass(own.state)">Ваш {{ own.text }}</span>
            </div>
            <BaseButton v-if="own.state !== 'off'" size="sm" color="danger" variant="pastel" :loading="disconnecting === user.id" @click="onDisconnect(user.id)">Отключить</BaseButton>
        </BaseCard>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="sessions"
                :loading="sessionsLoading"
                class="flex-auto"
                id="sessions"
            >
                <template #state="{ item }">
                    <span :class="stateClass(item.telegram?.state)">{{ item.telegram?.text ?? '' }}</span>
                </template>
                <template #actions="{ item }">
                    <BaseButton
                        v-if="item.id === user.id || isAdmin"
                        size="sm"
                        color="danger"
                        variant="pastel"
                        :loading="disconnecting === item.id"
                        @click.stop="onDisconnect(item.id)"
                    >
                        Отключить
                    </BaseButton>
                </template>
            </BaseTable>
        </div>
        <MessengerFilters channel="telegram" />
        <TelegramConfirmation :phone="codePhone" @confirmed="onConfirmed" />
    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import type { Column } from '~/components/common/types';
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
type Health = { state: 'ok' | 'connecting' | 'broken' | 'off' | 'unknown'; text: string; since?: string | null };
type SessionRow = User & { telegram?: Health & { account?: string | null; last_message_at?: number | null } };

const columns: Column<SessionRow>[] = [
    {
        label: 'Имя',
        name: 'username'
    },
    {
        label: 'Аккаунт',
        name: 'account',
        field: (item) => item.telegram?.account ?? item.phone ?? ''
    },
    {
        label: 'Состояние',
        name: 'state'
    },
    {
        label: 'Последнее сообщение',
        name: 'last_message',
        field: (item) => lastMessage(item.telegram?.last_message_at)
    },
    {
        label: '',
        name: 'actions'
    }
]

const toast = useToast('GlobalToast');
const user = useState<User>('user');
const isAdmin = computed(() => user.value?.role === UserRole.Admin);
const telegramConfirmation = useModal('TelegramConfirmation');
const sortBy = ref({});
const telegramService = useService('telegram', {auth: true});
const messengerService = useService('messenger', {auth: true});
const {data: sessions, isLoading: sessionsLoading, run: runSessions} = useAsync<SessionRow[]>([]);
const {isLoading: sendingCode, runAsync} = useAsync();
const own = ref<Health | null>(null);
const codePhone = ref('');
const disconnecting = ref<number | null>(null);

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

function fetchSessions() {
    runSessions(telegramService.get('active-sessions').exec());
}

async function fetchOwn() {
    const result = await promiseResult(messengerService.get<{ telegram: Health }>('status').exec());
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
