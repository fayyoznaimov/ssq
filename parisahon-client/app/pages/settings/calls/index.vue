<template>
    <section class="flex flex-col gap-8">
        <header>
            <h1 class="text-xl">Запись звонков</h1>
            <p class="text-sm text-muted-500">
                Приложение-рекордер на телефоне менеджера отправляет каждый звонок в CRM. Здесь выдаются токены, видна очередь
                с ошибками и все записи.
            </p>
        </header>

        <!-- FTP: the phone syncs its recordings folder to the CRM -->
        <BaseCard v-if="ftp" rounded="sm" class="p-4 text-sm flex flex-col gap-2">
            <h2 class="font-semibold">Записи с телефона по FTP</h2>
            <p>В приложении на телефоне, которое отправляет папку с записями звонков по FTP, укажите:</p>
            <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                <span class="text-muted-500">Сервер</span><code class="select-all break-all">{{ ftp.host }}</code>
                <span class="text-muted-500">Порт</span><code class="select-all">{{ ftp.port }}</code>
                <span class="text-muted-500">Логин</span><span>любой, например <code>crm</code></span>
                <span class="text-muted-500">Пароль</span><span>токен менеджера (выдаётся ниже)</span>
                <span class="text-muted-500">Режим</span><span>пассивный</span>
                <span class="text-muted-500">Шифрование</span><span>FTPS (явный TLS, «AUTH TLS»), если приложение его умеет</span>
            </div>
            <p class="text-muted-500">
                Номер, направление и время звонка CRM берёт из имени файла (Cube ACR и другие рекордеры).
                Один и тот же файл дважды не попадёт; обрезанная копия звонка не задвоит его — остаётся более длинная запись.
            </p>
            <p class="text-amber-600">
                Без шифрования токен передаётся открытым текстом: такой телефон подключайте только в офисной сети или через VPN.
            </p>
        </BaseCard>

        <!-- recorder set-up -->
        <BaseCard rounded="sm" class="p-4 text-sm flex flex-col gap-2">
            <h2 class="font-semibold">Как настроить рекордер</h2>
            <p>Адрес загрузки: <code class="px-1 rounded bg-muted-100 dark:bg-muted-800 break-all">POST {{ uploadUrl }}</code></p>
            <p>Заголовок: <code class="px-1 rounded bg-muted-100 dark:bg-muted-800">X-Recorder-Token: &lt;токен менеджера&gt;</code></p>
            <p>
                Тело multipart: поле <code>file</code> — аудио (.amr, .mp3, .m4a), и либо поля <code>duration</code> (мс),
                <code>number</code>, <code>direction</code> (Incoming / Outgoing), либо поле <code>meta</code> — тот же .json,
                что рекордер кладёт рядом с записью.
            </p>
            <p class="text-muted-500">Файлы из папок рекордера (запасной способ) Telegram-сервис отправляет на этот же адрес сам.</p>
        </BaseCard>

        <!-- tokens -->
        <BaseCard rounded="sm" class="p-4 flex flex-col gap-3">
            <h2 class="font-semibold">Токены менеджеров</h2>
            <p v-if="issued" class="rounded-md border border-primary-300 bg-primary-50 dark:bg-primary-900/30 p-3 text-sm">
                Токен для <b>{{ issued.username }}</b> (показывается один раз, скопируйте в рекордер):
                <code class="block mt-1 break-all select-all">{{ issued.token }}</code>
            </p>
            <table class="w-full text-sm">
                <thead class="text-left text-muted-500">
                    <tr><th class="py-1">Сотрудник</th><th>Токен</th><th>Выдан</th><th>Последняя загрузка</th><th></th></tr>
                </thead>
                <tbody>
                    <tr v-for="row in tokens" :key="row.user_id" class="border-t border-muted-200 dark:border-muted-700">
                        <td class="py-2">{{ row.username }} <span class="text-muted-400">({{ row.role }})</span></td>
                        <td>{{ row.has_token ? 'выдан' : '—' }}</td>
                        <td>{{ fmt(row.issued_at) }}</td>
                        <td>{{ fmt(row.last_upload_at) }}</td>
                        <td class="text-right whitespace-nowrap">
                            <BaseButton size="sm" color="primary" :loading="busy === 'issue' + row.user_id" @click="issue(row)">
                                {{ row.has_token ? 'Перевыдать' : 'Выдать' }}
                            </BaseButton>
                            <BaseButton v-if="row.has_token" size="sm" color="danger" variant="pastel" class="ml-2" :loading="busy === 'revoke' + row.user_id" @click="revoke(row)">
                                Отозвать
                            </BaseButton>
                        </td>
                    </tr>
                </tbody>
            </table>
        </BaseCard>

        <!-- queue -->
        <BaseCard rounded="sm" class="p-4 flex flex-col gap-3">
            <div class="flex items-center justify-between gap-2">
                <h2 class="font-semibold">Очередь загрузок</h2>
                <div class="flex items-center gap-2">
                    <select v-model="queueStatus" class="text-sm rounded-md border border-muted-300 dark:border-muted-700 bg-transparent px-2 py-1" @change="loadQueue">
                        <option value="failed">с ошибкой</option>
                        <option value="pending">в очереди</option>
                        <option value="done">обработанные</option>
                        <option value="duplicate">повторы</option>
                        <option value="all">все</option>
                    </select>
                    <BaseButton size="sm" variant="pastel" :loading="busy === 'process'" @click="processNow">Обработать сейчас</BaseButton>
                </div>
            </div>
            <p v-if="!queue.length" class="text-sm text-muted-500">Пусто.</p>
            <table v-else class="w-full text-sm">
                <thead class="text-left text-muted-500">
                    <tr><th class="py-1">Получен</th><th>Менеджер</th><th>Файл</th><th>Номер</th><th>Статус</th><th>Ошибка</th><th></th></tr>
                </thead>
                <tbody>
                    <tr v-for="u in queue" :key="u.id" class="border-t border-muted-200 dark:border-muted-700 align-top">
                        <td class="py-2 whitespace-nowrap">{{ fmt(u.received_at) }}</td>
                        <td>{{ u.user?.username }}</td>
                        <td class="break-all">{{ u.file_name }} <span class="text-muted-400">{{ u.source === 'folder' ? '(из папки)' : u.source === 'ftp' ? '(FTP)' : '' }}</span></td>
                        <td class="whitespace-nowrap">{{ u.from_number || u.caller_name || '—' }} {{ u.outgoing ? '↗' : '↙' }}</td>
                        <td>{{ statusLabel[u.status] || u.status }}</td>
                        <td class="break-all" :class="u.status === 'duplicate' ? 'text-muted-500' : 'text-rose-600'">{{ u.error }}</td>
                        <td class="text-right whitespace-nowrap">
                            <template v-if="u.status === 'failed' || u.status === 'pending'">
                                <BaseButton v-if="u.status === 'failed'" size="sm" variant="pastel" :loading="busy === 'retry' + u.id" @click="retry(u)">Повторить</BaseButton>
                                <BaseButton size="sm" color="danger" variant="pastel" class="ml-2" :loading="busy === 'discard' + u.id" @click="discard(u)">Убрать</BaseButton>
                            </template>
                        </td>
                    </tr>
                </tbody>
            </table>
        </BaseCard>

        <!-- recordings -->
        <BaseCard rounded="sm" class="p-4 flex flex-col gap-3">
            <div class="flex flex-wrap items-end justify-between gap-2">
                <h2 class="font-semibold">Все записи</h2>
                <div class="flex flex-wrap items-end gap-2 text-sm">
                    <select v-model="filters.user_id" class="rounded-md border border-muted-300 dark:border-muted-700 bg-transparent px-2 py-1" @change="loadRecordings">
                        <option value="">все менеджеры</option>
                        <option v-for="row in tokens" :key="row.user_id" :value="String(row.user_id)">{{ row.username }}</option>
                    </select>
                    <input v-model="filters.from" type="date" class="rounded-md border border-muted-300 dark:border-muted-700 bg-transparent px-2 py-1" @change="loadRecordings" />
                    <input v-model="filters.till" type="date" class="rounded-md border border-muted-300 dark:border-muted-700 bg-transparent px-2 py-1" @change="loadRecordings" />
                    <input v-model="filters.number" placeholder="номер" class="rounded-md border border-muted-300 dark:border-muted-700 bg-transparent px-2 py-1 w-36" @change="loadRecordings" />
                </div>
            </div>
            <p v-if="!recordings.data.length" class="text-sm text-muted-500">Записей нет.</p>
            <ul v-else class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700">
                <li v-for="r in recordings.data" :key="r.id" class="py-2 flex flex-col gap-1 md:flex-row md:items-center md:gap-4">
                    <div class="text-sm md:w-72 shrink-0">
                        <div>{{ fmt(r.created_at) }} · {{ r.user?.username }}</div>
                        <div class="text-muted-500">{{ r.from_number || 'номер неизвестен' }} · {{ r.outgoing ? 'исходящий' : 'входящий' }} · {{ minutes(r.duration) }}</div>
                        <div v-if="r.contact" class="text-muted-500">клиент: {{ r.contact.username }}</div>
                        <NuxtLink v-if="r.deal" :to="`/deals/${r.deal.id}`" class="text-primary-600 underline">{{ r.deal.label }}</NuxtLink>
                        <div v-else class="flex flex-wrap items-center gap-2">
                            <span class="text-muted-400">нет в сделках</span>
                            <BaseButton v-if="r.from_number" size="sm" color="primary" variant="pastel" :loading="busy === 'deal' + r.id" @click="createDeal(r)">
                                Создать сделку
                            </BaseButton>
                        </div>
                    </div>
                    <AudioPlayer :src="r.path" class="flex-1" />
                </li>
            </ul>
            <div v-if="recordings.count > recordings.limit" class="flex items-center gap-2 text-sm">
                <BaseButton size="sm" variant="pastel" :disabled="recordings.page <= 1" @click="page(recordings.page - 1)">←</BaseButton>
                <span>{{ recordings.page }} / {{ Math.ceil(recordings.count / recordings.limit) }}</span>
                <BaseButton size="sm" variant="pastel" :disabled="recordings.page * recordings.limit >= recordings.count" @click="page(recordings.page + 1)">→</BaseButton>
            </div>
        </BaseCard>
    </section>
</template>

<script lang="ts" setup>
import AudioPlayer from '~/components/common/AudioPlayer.vue';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Запись звонков',
    subject: 'CallRecorder',
});

useHead({ title: 'Запись звонков' });

type TokenRow = { user_id: number; username: string; role: string; has_token: boolean; issued_at: string | null; last_upload_at: string | null };
type QueueRow = { id: number; user: { id: number; username: string } | null; file_name: string; from_number: string | null; caller_name: string | null; outgoing: boolean; source: string; status: string; error: string | null; received_at: string };
type RecordingRow = { id: number; user: { id: number; username: string } | null; duration: number; outgoing: boolean; path: string; from_number: string | null; created_at: string; deal: { id: number; label: string } | null; contact?: { id: number; username: string } | null };

const toast = useToast('GlobalToast');
const config = useRuntimeConfig();
const callsService = useService('calls', { auth: true });

const uploadUrl = computed(() => `${config.public.apiUrl}/calls/upload`);
const tokens = ref<TokenRow[]>([]);
const issued = ref<{ username: string; token: string } | null>(null);
// "host:port" of the FTP receiver (parisahon-ftp); null — it is not set up on this server
const ftp = ref<{ host: string; port: string } | null>(null);
const queue = ref<QueueRow[]>([]);
const queueStatus = ref('failed');
const recordings = ref<{ data: RecordingRow[]; count: number; page: number; limit: number }>({ data: [], count: 0, page: 1, limit: 50 });
const filters = reactive({ user_id: '', from: '', till: '', number: '' });
const busy = ref('');
const statusLabel: Record<string, string> = { pending: 'в очереди', done: 'обработан', failed: 'ошибка', discarded: 'убран', duplicate: 'повтор' };

function fmt(value: string | null) {
    return value ? new Date(value).toLocaleString('ru') : '—';
}
function minutes(ms: number) {
    const s = Math.round((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fail(error: any) {
    toast.show({ type: 'error', message: [error?.message ?? 'Ошибка'].flat().join('; '), timeout: 4000 });
}

async function loadFtp() {
    const r = await promiseResult(callsService.get('ftp').exec());
    const address = r.ok ? String((r.value as { address: string | null }).address ?? '') : '';
    const at = address.lastIndexOf(':');
    ftp.value = address ? { host: at > 0 ? address.slice(0, at) : address, port: at > 0 ? address.slice(at + 1) : '21' } : null;
}
async function loadTokens() {
    const r = await promiseResult(callsService.get('tokens').exec());
    if (r.ok) tokens.value = r.value as TokenRow[]; else fail(r.error);
}
async function loadQueue() {
    const r = await promiseResult(callsService.get(`queue?status=${queueStatus.value}`).exec());
    if (r.ok) queue.value = r.value as QueueRow[]; else fail(r.error);
}
async function loadRecordings(p = 1) {
    const params = new URLSearchParams({ page: String(p), limit: '50' });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    const r = await promiseResult(callsService.get(`recordings?${params}`).exec());
    if (r.ok) recordings.value = r.value as typeof recordings.value; else fail(r.error);
}
function page(p: number) {
    loadRecordings(p);
}

async function issue(row: TokenRow) {
    if (row.has_token && !confirm(`Перевыдать токен для ${row.username}? Старый перестанет работать.`)) return;
    busy.value = 'issue' + row.user_id;
    const r = await promiseResult(callsService.post('/tokens', { user_id: row.user_id }).exec());
    busy.value = '';
    if (!r.ok) return fail(r.error);
    issued.value = { username: row.username, token: (r.value as any).token };
    await loadTokens();
}
async function revoke(row: TokenRow) {
    if (!confirm(`Отозвать токен ${row.username}? Рекордер перестанет загружать звонки.`)) return;
    busy.value = 'revoke' + row.user_id;
    const r = await promiseResult(callsService.remove(`tokens/${row.user_id}`).exec());
    busy.value = '';
    if (!r.ok) return fail(r.error);
    if (issued.value?.username === row.username) issued.value = null;
    await loadTokens();
}
async function retry(u: QueueRow) {
    busy.value = 'retry' + u.id;
    const r = await promiseResult(callsService.post(`/queue/${u.id}/retry`, {}).exec());
    busy.value = '';
    if (!r.ok) return fail(r.error);
    await loadQueue();
}
async function discard(u: QueueRow) {
    if (!confirm('Убрать файл из очереди? Он будет удалён.')) return;
    busy.value = 'discard' + u.id;
    const r = await promiseResult(callsService.remove(`queue/${u.id}`).exec());
    busy.value = '';
    if (!r.ok) return fail(r.error);
    await loadQueue();
}
// a call from a number the CRM does not know: the client (found or created) and their deal, with every earlier call of that number
async function createDeal(row: RecordingRow) {
    busy.value = 'deal' + row.id;
    const r = await promiseResult(callsService.post(`/recordings/${row.id}/deal`, {}).exec());
    busy.value = '';
    if (!r.ok) return fail(r.error);
    const v = r.value as { deal: { id: number; label: string }; created_deal: boolean; linked: number };
    const what = v.created_deal ? 'Сделка создана' : 'Запись добавлена в сделку';
    toast.show({ type: 'success', message: `${what}: ${v.deal.label}` + (v.linked > 1 ? ` (звонков: ${v.linked})` : ''), timeout: 4000 });
    await loadRecordings(recordings.value.page);
}
async function processNow() {
    busy.value = 'process';
    const r = await promiseResult(callsService.post('/process', {}).exec());
    busy.value = '';
    if (!r.ok) return fail(r.error);
    const v = r.value as { done: number; failed: number; duplicate?: number };
    toast.show({ type: 'success', message: `Обработано: ${v.done}, с ошибкой: ${v.failed}` + (v.duplicate ? `, повторов: ${v.duplicate}` : ''), timeout: 3000 });
    await Promise.all([loadQueue(), loadRecordings(), loadTokens()]);
}

// a phone has sent a recording, or it has been processed: the queue and the list follow by themselves
useLive((changes) => {
    if (!liveTouches(changes, 'calls')) return;
    loadQueue();
    loadRecordings(recordings.value.page);
}, 2000);

onMounted(() => {
    loadFtp();
    loadTokens();
    loadQueue();
    loadRecordings();
});
</script>
