<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">WhatsApp</h1>
            <p class="text-sm text-muted-500">Переписка с клиентами из WhatsApp менеджеров приходит в их сделки. Подключить можно только свой WhatsApp.</p>
        </div>
        <WhatsAppConnect />
        <div v-if="isAdmin" class="flex flex-col gap-3">
            <h2 class="text-lg">Подключённые номера</h2>
            <p v-if="sessionsError" class="text-sm text-red-500">{{ sessionsError }}</p>
            <p v-else-if="!sessions.length" class="text-sm text-muted-500">Пока никто не подключил WhatsApp.</p>
            <ul v-else class="divide-y divide-muted-200 dark:divide-muted-700 max-w-2xl">
                <li v-for="s in sessions" :key="s.user_id" class="py-2 flex justify-between gap-4 text-sm">
                    <span>{{ userName(s.user_id) }}</span>
                    <span class="text-muted-500">{{ s.phone || '' }}</span>
                    <span :class="s.status === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600'">{{ statusLabel[s.status] ?? s.status }}</span>
                </li>
            </ul>
        </div>
    </div>
</template>

<script lang="ts" setup>
import WhatsAppConnect from '~/components/whatsapp/WhatsAppConnect.vue';
import { type User, UserRole } from '~/types/user';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'WhatsApp',
    subject: 'WhatsApp'
});

useHead({ title: 'WhatsApp' });

type Session = { user_id: number; status: string; phone?: string };
const statusLabel: Record<string, string> = { connected: 'Подключён', starting: 'Подключается', qr: 'Ждёт QR', code: 'Ждёт код', logged_out: 'Отключён телефоном', none: 'Не подключён' };

const user = useState<User>('user');
const isAdmin = computed(() => user.value?.role === UserRole.Admin);
const service = useService('whatsapp', { auth: true });
const userService = useService('users', { auth: true });
const sessions = ref<Session[]>([]);
const sessionsError = ref('');
const users = ref<User[]>([]);

const userName = (id: number) => users.value.find((u) => u.id === id)?.username ?? `#${id}`;

async function load() {
    if (!isAdmin.value) return;
    try {
        sessions.value = await service.get<Session[]>('sessions').exec();
        sessionsError.value = '';
    } catch (e: any) {
        sessionsError.value = e?.data?.message || e?.message || 'WhatsApp-сервис недоступен';
    }
    try {
        const res: any = await userService.find({ limit: 1000 }).exec();
        users.value = res?.data ?? res ?? [];
    } catch {
        users.value = [];
    }
}

onMounted(load);
</script>
