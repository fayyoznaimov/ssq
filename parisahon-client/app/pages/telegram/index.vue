<template>
    <div class="flex flex-col gap-8">
        <div class="flex items-center justify-between">
            <div>
                <h1 class="text-xl">Активные сеансы</h1>
                <p class="text-sm text-muted-500">Подключённые Telegram-аккаунты менеджеров. Подключить можно только свой: код придёт в Telegram на ваш номер из профиля.</p>
            </div>
            <BaseButton color="primary" @click="onConnect" :disabled="sendingCode">
                Подключить
            </BaseButton>
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="sessions"
                :loading="sessionsLoading"
                class="flex-auto"
                id="sessions"
            >
            </BaseTable>
        </div>
        <TelegramConfirmation @confirmed="fetchSessions" />
    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import type { Column } from '~/components/common/types';
import TelegramConfirmation from '~/components/modals/TelegramConfirmation.vue';
import type { User } from '~/types/user';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Телеграм',
    subject: 'Telegram'
});

useHead({
    title: 'Телеграм'
});

const columns: Column[] = [
    {
        label: 'Имя',
        name: 'username'
    },
    {
        label: 'Номер телефона',
        name: 'phone'
    },
    {
        label: 'Почта',
        name: 'email'
    }
]

const toast = useToast('GlobalToast');
const user = useState<User>('user');
const telegramConfirmation = useModal('TelegramConfirmation');
const sortBy = ref({});
const telegramService = useService('telegram', {auth: true});
const {data: sessions, isLoading: sessionsLoading, run: runSessions} = useAsync<User[]>([]);
const {isLoading: sendingCode, runAsync} = useAsync();

async function onConnect() {
    // own account only; the Telegram application keys are on the server
    const result = await promiseResult(runAsync(telegramService.post('/send-code', {
        user_id: user.value.id,
    }).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    telegramConfirmation.open();
}

function fetchSessions()  {
    runSessions(telegramService.get('active-sessions').exec())
}

onMounted(fetchSessions);

</script>