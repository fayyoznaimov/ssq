<script setup lang="ts">
// The manager's own WhatsApp, connected like WhatsApp Web: scan the QR code with
// the phone (WhatsApp → Связанные устройства → Привязка устройства). Chats of this
// number then come into the deals (parisahon-whatsapp-service → POST /whatsapp/incoming).
import { renderSVG } from 'uqr';

type State = { status: 'none' | 'starting' | 'qr' | 'code' | 'connected' | 'logged_out'; qr?: string; code?: string; phone?: string; name?: string; passkey?: boolean };

const service = useService('whatsapp', { auth: true });
const state = ref<State | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const me = useState<any>('user');
const byPhone = ref(false);
const profilePhone = computed(() => (me.value?.phone ?? '').trim());
const phone = ref<string>(me.value?.phone ?? '');
let timer: ReturnType<typeof setInterval> | undefined;

const qrSvg = computed(() => (state.value?.status === 'qr' && state.value.qr ? renderSVG(state.value.qr, { border: 2 }) : ''));

function message(e: any) {
    return e?.data?.message || e?.message || 'WhatsApp-сервис недоступен';
}

async function load() {
    try {
        state.value = await service.get<State>('status').exec();
        error.value = '';
    } catch (e) {
        error.value = message(e);
    } finally {
        loading.value = false;
    }
    // keep polling while the QR is shown or the session is starting
    const waiting = ['qr', 'code', 'starting'].includes(state.value?.status ?? '');
    if (waiting && !timer) timer = setInterval(load, 2000);
    if (!waiting && timer) {
        clearInterval(timer);
        timer = undefined;
    }
}

async function connect(withPhone = false) {
    busy.value = true;
    try {
        state.value = await service.post<State>('connect', withPhone ? { phone: phone.value } : {}).exec();
        error.value = '';
        await load();
    } catch (e) {
        error.value = message(e);
    } finally {
        busy.value = false;
    }
}

async function disconnect() {
    if (state.value?.status === 'connected' && !confirm('Отключить WhatsApp от CRM? Сообщения перестанут приходить в сделки.')) return;
    busy.value = true;
    try {
        state.value = await service.remove<State>('session').exec();
    } catch (e) {
        error.value = message(e);
    } finally {
        busy.value = false;
    }
}

onMounted(load);
onUnmounted(() => timer && clearInterval(timer));
</script>

<template>
    <BaseCard class="p-6 flex flex-col gap-3 max-w-2xl">
        <div class="flex items-center gap-2">
            <Icon name="ph:whatsapp-logo" class="size-6 text-emerald-500" />
            <h3 class="text-lg">WhatsApp</h3>
        </div>
        <p class="text-sm text-gray-500">Переписка с клиентами из вашего WhatsApp будет приходить в их сделки, отвечать можно прямо из сделки.</p>
        <p v-if="loading" class="text-sm text-gray-500">Загрузка…</p>
        <p v-else-if="error" class="text-sm text-red-500">{{ error }}</p>
        <template v-if="state && !loading">
            <template v-if="state.status === 'connected'">
                <p class="text-sm">Подключено{{ state.phone ? `: ${state.phone}` : '' }}{{ state.name ? ` (${state.name})` : '' }}.</p>
                <div>
                    <BaseButton color="danger" variant="pastel" :loading="busy" @click="disconnect">Отключить</BaseButton>
                </div>
            </template>
            <template v-else-if="state.status === 'qr' && qrSvg">
                <p class="text-sm">Откройте WhatsApp на телефоне → <b>Настройки → Связанные устройства → Привязка устройства</b> и наведите камеру на код. Код обновляется сам.</p>
                <div class="w-64 max-w-full rounded-md bg-white p-2" v-html="qrSvg"></div>
                <p v-if="state.passkey" class="text-sm text-amber-600 dark:text-amber-400">WhatsApp просит ключ доступа (отпечаток) — по QR так не подключить. Нажмите «Отменить» и подключите по номеру телефона.</p>
                <div>
                    <BaseButton variant="pastel" :loading="busy" @click="disconnect">Отменить</BaseButton>
                </div>
            </template>
            <template v-else-if="state.status === 'code' && state.code">
                <p class="text-sm">Откройте WhatsApp на телефоне → <b>Настройки → Связанные устройства → Привязка устройства</b> → внизу <b>«Привязать по номеру телефона»</b> и введите код:</p>
                <p class="text-3xl font-mono tracking-widest select-all">{{ state.code }}</p>
                <div>
                    <BaseButton variant="pastel" :loading="busy" @click="disconnect">Отменить</BaseButton>
                </div>
            </template>
            <template v-else-if="state.status === 'starting'">
                <p class="text-sm text-gray-500">Готовим QR-код…</p>
            </template>
            <template v-else>
                <p v-if="state.status === 'logged_out'" class="text-sm text-amber-600">WhatsApp отключил это устройство. Подключите заново.</p>
                <div class="flex flex-wrap gap-2">
                    <!-- the manager's number from the profile: one click, the code comes at once (like Telegram) -->
                    <!-- on a phone the label takes two lines: the button grows instead of the text spilling out -->
                    <BaseButton v-if="profilePhone" color="primary" :loading="busy" class="!h-auto min-h-10 py-2 text-center" @click="phone = profilePhone; connect(true)">
                        <span>Подключить WhatsApp <span class="whitespace-nowrap">{{ profilePhone }}</span></span>
                    </BaseButton>
                    <BaseButton :color="profilePhone ? 'default' : 'primary'" :variant="profilePhone ? 'pastel' : 'solid'" :loading="busy && !byPhone" @click="connect(false)">По QR-коду</BaseButton>
                    <BaseButton variant="pastel" :disabled="busy" @click="byPhone = !byPhone">{{ profilePhone ? 'Другой номер' : 'По номеру телефона' }}</BaseButton>
                </div>
                <form v-if="byPhone" class="flex flex-wrap items-end gap-2" @submit.prevent="connect(true)">
                    <BaseInput v-model="phone" label="Номер WhatsApp с кодом страны" placeholder="+998 90 123 45 67" class="max-w-xs" required />
                    <BaseButton type="submit" color="primary" :loading="busy">Получить код</BaseButton>
                </form>
                <p class="text-xs text-gray-500">Если после сканирования QR телефон просит отпечаток и снова открывает камеру — подключайте по номеру телефона.</p>
            </template>
        </template>
    </BaseCard>
</template>
