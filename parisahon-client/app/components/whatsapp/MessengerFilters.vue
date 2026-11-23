<script setup lang="ts">
// Which chats of the manager's own Telegram / WhatsApp do not come into the CRM (shared by the
// Telegram and WhatsApp pages, API /messenger):
//  - «Не клиент»: family, friends, suppliers — their chats never become contacts and deals
//    (colleagues are never clients anyway); contacts made from such chats before are not deleted;
//  - «Только известные контакты»: a chat with somebody who is not in the CRM creates nothing.
type Channel = 'telegram' | 'whatsapp';
type Ignored = { id: number; channel: Channel | null; tg_id: string | null; wa_id: string | null; phone_key: string | null; label: string | null; contact_id: number | null; created_at: string };
type Settings = { user_id: number; known_only: Record<Channel, boolean>; default_known_only: boolean };

const props = defineProps<{ channel: Channel }>();

const service = useService('messenger', { auth: true });
const toast = useToast('GlobalToast');
const list = ref<Ignored[]>([]);
const settings = ref<Settings | null>(null);
const phone = ref('');
const busy = ref(false);
const error = ref('');

const name = computed(() => (props.channel === 'telegram' ? 'Telegram' : 'WhatsApp'));
const knownOnly = computed({
    get: () => Boolean(settings.value?.known_only?.[props.channel]),
    set: (value: boolean) => { void saveKnownOnly(value); },
});
const channelLabel = (c: Channel | null) => (c === 'telegram' ? 'только Telegram' : c === 'whatsapp' ? 'только WhatsApp' : 'Telegram и WhatsApp');
const what = (item: Ignored) => item.label || (item.phone_key ? `…${item.phone_key}` : item.tg_id ? `Telegram ${item.tg_id}` : 'чат WhatsApp');

function message(e: any) {
    return e?.data?.message || e?.message || 'Не удалось сохранить';
}

async function load() {
    try {
        const [items, current] = await Promise.all([
            service.get<Ignored[]>('ignored').exec(),
            service.get<Settings>('settings').exec(),
        ]);
        list.value = Array.isArray(items) ? items : [];
        settings.value = current;
        error.value = '';
    } catch (e) {
        error.value = message(e);
    }
}

async function saveKnownOnly(value: boolean) {
    busy.value = true;
    try {
        settings.value = await service.patch<Settings>('settings', { channel: props.channel, known_only: value }).exec();
    } catch (e) {
        toast.show({ type: 'error', message: message(e), timeout: 5000 });
    } finally {
        busy.value = false;
    }
}

async function add() {
    if (!phone.value.trim()) return;
    busy.value = true;
    try {
        await service.post('ignored', { phone: phone.value }).exec();
        phone.value = '';
        await load();
    } catch (e) {
        toast.show({ type: 'error', message: message(e), timeout: 5000 });
    } finally {
        busy.value = false;
    }
}

async function remove(item: Ignored) {
    busy.value = true;
    try {
        await service.remove(`ignored/${item.id}`).exec();
        list.value = list.value.filter((i) => i.id !== item.id);
    } catch (e) {
        toast.show({ type: 'error', message: message(e), timeout: 5000 });
    } finally {
        busy.value = false;
    }
}

onMounted(load);
</script>

<template>
    <BaseCard class="p-6 flex flex-col gap-4 max-w-2xl">
        <div>
            <h3 class="text-lg">Какие чаты не попадают в CRM</h3>
            <p class="text-sm text-muted-500">
                Чаты с коллегами в CRM не попадают никогда. Личные чаты (родные, друзья, поставщики) отметьте «Не клиент» —
                здесь по номеру или в сделке кнопкой «Не клиент»: новые сообщения от них не создадут ни контакт, ни сделку.
                Уже созданные контакты и сделки не удаляются — закройте или удалите их сами.
            </p>
        </div>
        <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
        <div v-if="settings" class="flex flex-col gap-1">
            <BaseSwitchThin v-model="knownOnly" :disabled="busy" color="primary" :label="`Только известные контакты (${name})`" />
            <p class="text-xs text-muted-500">
                Включено: из вашего {{ name }} в CRM попадают только чаты с теми, кто уже есть в CRM; новый человек, написавший первым,
                контакт и сделку не создаёт. Выключено: новый клиент сам становится контактом и сделкой.
            </p>
        </div>
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="add">
            <BaseInput v-model="phone" label="Номер, который не клиент" placeholder="+998 90 123 45 67" class="max-w-xs" />
            <BaseButton type="submit" :loading="busy" :disabled="!phone.trim()">Не клиент</BaseButton>
        </form>
        <p v-if="!list.length && !error" class="text-sm text-muted-500">Список «Не клиент» пуст.</p>
        <ul v-else class="divide-y divide-muted-200 dark:divide-muted-700">
            <li v-for="item in list" :key="item.id" class="py-2 flex items-center justify-between gap-3 text-sm">
                <div class="min-w-0">
                    <div class="truncate">{{ what(item) }}</div>
                    <div class="text-xs text-muted-500">{{ channelLabel(item.channel) }}</div>
                </div>
                <BaseButton size="sm" variant="pastel" :disabled="busy" @click="remove(item)">Вернуть</BaseButton>
            </li>
        </ul>
    </BaseCard>
</template>
