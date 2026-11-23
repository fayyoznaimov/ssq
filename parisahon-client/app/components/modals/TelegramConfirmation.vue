<template>
    <Modal
        :id="props.id"
    >
        <template #header>
            <div class="flex">
                <h2>
                    Подтвердить подключение
                </h2>
            </div>
        </template>
        <form class="flex flex-col gap-3" @submit.prevent="onConfirm">
            <p class="text-sm text-muted-500">
                Telegram прислал код{{ props.phone ? ` для номера ${props.phone}` : '' }} — в приложение Telegram (чат «Telegram»), не по SMS.
                На ввод кода есть 5 минут; если код неверный, введите его ещё раз — новый код не нужен.
            </p>
            <BaseInput label="Код из Telegram" v-model="code" autocomplete="one-time-code" inputmode="numeric" />
            <BaseInput
                v-if="needsPassword"
                label="Облачный пароль (двухэтапная проверка)"
                type="password"
                v-model="password"
                autocomplete="current-password"
            />
            <p v-if="needsPassword" class="text-sm text-muted-500">
                На аккаунте включена двухэтапная проверка: введите пароль Telegram вместе с кодом.
            </p>
            <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
            <button type="submit" class="hidden" />
        </form>
        <template #footer>
            <div class="flex gap-2">
                <div class="flex-initial">
                    <BaseButton
                        color="primary"
                        @click="onConfirm"
                        :loading="isLoading"
                        :disabled="isLoading || !code.trim()"
                    >
                        Подтвердить
                    </BaseButton>
                </div>
            </div>
        </template>
    </Modal>
</template>

<script lang="ts" setup>
import Modal from '~/components/common/Modal.vue';
import type { User } from '~/types/user';

// phone: where Telegram sent the code (masked, from POST /telegram/send-code)
const props = withDefaults(defineProps<{ id: string; phone?: string }>(), {id: 'TelegramConfirmation', phone: ''});
const emit = defineEmits(['confirmed']);

const user = useState<User>('user');
const toast = useToast('GlobalToast');
const modal = useModal(props.id);
const code = ref('');
const password = ref('');
const needsPassword = ref(false);
const error = ref('');
const telegramService = useService('telegram', {auth: true});
const {isLoading, runAsync} = useAsync();

async function onConfirm() {
    if (isLoading.value || !code.value.trim()) return;
    error.value = '';
    const body: Record<string, string | number> = { user_id: user.value.id, code: code.value.trim() };
    if (needsPassword.value && password.value) body.password = password.value;
    const result = await promiseResult(runAsync(telegramService.post('/activate-auth', body).exec()));
    if (!result.ok) {
        const data = (result.error as any)?.data ?? {};
        // the API relays needs_password from the Telegram service: ask for the cloud password and retry
        if (data.needs_password || (result.error as any)?.needs_password) {
            needsPassword.value = true;
        }
        // the error stays in the window (a wrong code or password: type it again, the same code works)
        error.value = data.message || result.error.message || 'Telegram не подключён';
        return;
    }
    code.value = '';
    password.value = '';
    needsPassword.value = false;
    toast.show({type: 'success', message: 'Telegram подключён: переписка с клиентами будет приходить в сделки', timeout: 4000});
    emit('confirmed');
    modal.close();
}

</script>

<style scoped>

</style>
