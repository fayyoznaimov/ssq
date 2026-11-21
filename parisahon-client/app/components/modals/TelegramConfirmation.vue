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
        <div class="flex flex-col gap-3">
            <BaseInput label="Код из Telegram" v-model="code" autocomplete="one-time-code" />
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
        </div>
        <template #footer>
            <div class="flex gap-2">
                <div class="flex-initial">
                    <BaseButton
                        color="primary"
                        @click="onConfirm"
                        :disabled="isLoading"
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

const props = withDefaults(defineProps<{ id: string; }>(), {id: 'TelegramConfirmation'});
const emit = defineEmits(['confirmed']);

const user = useState<User>('user');
const toast = useToast('GlobalToast');
const modal = useModal(props.id);
const code = ref('');
const password = ref('');
const needsPassword = ref(false);
const telegramService = useService('telegram', {auth: true});
const {isLoading, runAsync} = useAsync();

async function onConfirm() {
    const body: Record<string, string | number> = { user_id: user.value.id, code: code.value };
    if (needsPassword.value && password.value) body.password = password.value;
    const result = await promiseResult(runAsync(telegramService.post('/activate-auth', body).exec()));
    if (!result.ok) {
        // the API relays needs_password from the Telegram service: ask for the cloud password and retry
        if ((result.error as any)?.data?.needs_password || (result.error as any)?.needs_password) {
            needsPassword.value = true;
        }
        return toast.show({type: 'error', message: result.error.message, timeout: 3000});
    }
    code.value = '';
    password.value = '';
    needsPassword.value = false;
    emit('confirmed');
    modal.close();
}

</script>

<style scoped>

</style>
