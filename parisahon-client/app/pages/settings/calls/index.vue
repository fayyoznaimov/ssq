<template>
    <section class="flex flex-col gap-6">
        <header>
            <h1 class="text-xl">Запись звонков</h1>
            <p class="text-sm text-muted-500">
                Записи звонков с телефонов менеджеров. Подключение телефона, токены и очередь — на второй вкладке.
            </p>
        </header>

        <BaseTabs v-model="activeTab" :tabs="tabs">
            <template #tab="{ activeValue }">
                <!-- recordings: the filters and the list come first -->
                <div v-if="activeValue === 'records'" class="flex flex-col gap-4">
                    <div class="flex flex-wrap items-center gap-2">
                        <BaseSelect v-model="filters.user_id" :classes="{ wrapper: 'w-full sm:w-56' }" aria-label="Менеджер">
                            <option value="">Все менеджеры</option>
                            <option v-for="row in tokens" :key="row.user_id" :value="String(row.user_id)">{{ row.username }}</option>
                        </BaseSelect>
                        <PeriodPicker v-model="period" />
                        <BaseSelect v-model="filters.direction" :classes="{ wrapper: 'w-full sm:w-44' }" aria-label="Направление">
                            <option value="">Все звонки</option>
                            <option value="in">Входящие</option>
                            <option value="out">Исходящие</option>
                        </BaseSelect>
                        <BaseInput v-model="filters.number" icon="ph:magnifying-glass" placeholder="Номер" :classes="{ wrapper: 'w-full sm:w-44' }" />
                        <span class="text-sm text-muted-500">{{ countOf(recordings.count, 'запись', 'записи', 'записей') }}</span>
                    </div>
                    <p v-if="!recordings.data.length" class="text-sm text-muted-500">Записей нет.</p>
                    <ul v-else class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700">
                        <li v-for="r in recordings.data" :key="r.id" class="py-2 flex flex-col gap-1 md:flex-row md:items-center md:gap-4">
                            <div class="text-sm md:w-80 shrink-0 min-w-0">
                                <div class="flex flex-wrap items-center gap-x-2">
                                    <Icon :name="r.outgoing ? 'ph:phone-outgoing' : 'ph:phone-incoming'" class="size-4" :class="r.outgoing ? 'text-primary-500' : 'text-success-500'" />
                                    <span>{{ formatDateTime(r.created_at) }}</span>
                                    <span class="text-muted-500">· {{ r.user?.username }}</span>
                                </div>
                                <div class="text-muted-500 break-words">
                                    {{ r.from_number ? formatPhone(r.from_number) : 'номер неизвестен' }} · {{ r.outgoing ? 'исходящий' : 'входящий' }} · {{ minutes(r.duration) }}
                                </div>
                                <div v-if="r.contact" class="text-muted-500">клиент: {{ r.contact.username }}</div>
                                <NuxtLink v-if="r.deal" :to="`/deals/${r.deal.id}`" class="text-primary-600 underline break-words">{{ r.deal.label }}</NuxtLink>
                                <div v-else class="flex flex-wrap items-center gap-2">
                                    <span class="text-muted-400">нет в сделках</span>
                                    <BaseButton v-if="r.from_number" size="sm" color="primary" variant="pastel" :loading="busy === 'deal' + r.id" @click="createDeal(r)">
                                        Создать сделку
                                    </BaseButton>
                                </div>
                            </div>
                            <AudioPlayer :src="r.path" :duration-ms="r.duration" class="flex-1" />
                        </li>
                    </ul>
                    <BasePagination
                        v-if="recordings.count > recordings.limit"
                        :current-page="recordings.page"
                        :item-per-page="recordings.limit"
                        :total-items="recordings.count"
                        :max-links-displayed="7"
                        shape="rounded"
                        @update:current-page="loadRecordings"
                    />
                </div>

                <!-- connecting a phone: tokens, the queue, the set-up -->
                <div v-else class="flex flex-col gap-6">
                    <BaseCard rounded="sm" class="p-4 flex flex-col gap-3">
                        <h2 class="font-semibold">Токены менеджеров</h2>
                        <p v-if="issued" class="rounded-md border border-primary-300 bg-primary-50 dark:bg-primary-900/30 p-3 text-sm">
                            Токен для <b>{{ issued.username }}</b> (показывается один раз, скопируйте в приложение на телефоне):
                            <code class="block mt-1 break-all select-all">{{ issued.token }}</code>
                        </p>
                        <div class="overflow-x-auto -mx-4 px-4">
                            <table class="w-full min-w-[640px] text-sm">
                                <thead class="text-left text-muted-500">
                                    <tr>
                                        <th class="py-1 pe-3">Сотрудник</th>
                                        <th class="pe-3">Токен</th>
                                        <th class="pe-3" title="Вход по FTP с этим токеном — только с шифрованием (FTPS)">Только FTPS</th>
                                        <th class="pe-3">Выдан</th>
                                        <th class="pe-3">Последняя загрузка</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="row in tokens" :key="row.user_id" class="border-t border-muted-200 dark:border-muted-700">
                                        <td class="py-2 pe-3">{{ row.username }} <span class="text-muted-400">({{ ROLES[row.role] ?? row.role }})</span></td>
                                        <td class="pe-3">{{ row.has_token ? 'выдан' : '—' }}</td>
                                        <td class="pe-3">
                                            <BaseCheckbox
                                                v-if="row.has_token"
                                                :model-value="row.tls_required"
                                                rounded="sm"
                                                color="primary"
                                                :disabled="busy === 'tls' + row.user_id"
                                                aria-label="Только FTPS"
                                                @update:model-value="(value: boolean) => setTls(row, value)"
                                            />
                                            <span v-else class="text-muted-400">—</span>
                                        </td>
                                        <td class="pe-3 whitespace-nowrap">{{ formatDateTime(row.issued_at) }}</td>
                                        <td class="pe-3 whitespace-nowrap">{{ formatDateTime(row.last_upload_at) }}</td>
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
                        </div>
                        <p class="text-xs text-muted-500">
                            «Только FTPS»: телефон с этим токеном входит по FTP только с шифрованием (FTPS, «AUTH TLS»); вход без шифрования
                            отклоняется. Включайте, как только приложение на телефоне переведено на FTPS.
                        </p>
                    </BaseCard>

                    <BaseCard rounded="sm" class="p-4 flex flex-col gap-3">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <h2 class="font-semibold">Очередь загрузок</h2>
                            <div class="flex flex-wrap items-center gap-2">
                                <BaseSelect v-model="queueStatus" :classes="{ wrapper: 'w-44' }" aria-label="Статус">
                                    <option value="failed">с ошибкой</option>
                                    <option value="pending">в очереди</option>
                                    <option value="done">обработанные</option>
                                    <option value="duplicate">повторы</option>
                                    <option value="all">все</option>
                                </BaseSelect>
                                <BaseButton size="sm" variant="pastel" class="whitespace-nowrap" :loading="busy === 'process'" @click="processNow">Обработать сейчас</BaseButton>
                            </div>
                        </div>
                        <p v-if="!queue.length" class="text-sm text-muted-500">Пусто.</p>
                        <div v-else class="overflow-x-auto -mx-4 px-4">
                            <table class="w-full min-w-[760px] text-sm">
                                <thead class="text-left text-muted-500">
                                    <tr><th class="py-1 pe-3">Получен</th><th class="pe-3">Менеджер</th><th class="pe-3">Файл</th><th class="pe-3">Номер</th><th class="pe-3">Статус</th><th class="pe-3">Ошибка</th><th></th></tr>
                                </thead>
                                <tbody>
                                    <tr v-for="u in queue" :key="u.id" class="border-t border-muted-200 dark:border-muted-700 align-top">
                                        <td class="py-2 pe-3 whitespace-nowrap">{{ formatDateTime(u.received_at) }}</td>
                                        <td class="pe-3">{{ u.user?.username }}</td>
                                        <td class="pe-3 break-all">{{ u.file_name }} <span class="text-muted-400">{{ u.source === 'folder' ? '(из папки)' : u.source === 'ftp' ? '(FTP)' : '' }}</span></td>
                                        <td class="pe-3 whitespace-nowrap">{{ u.from_number || u.caller_name || '—' }} {{ u.outgoing ? '↗' : '↙' }}</td>
                                        <td class="pe-3">{{ statusLabel[u.status] || u.status }}</td>
                                        <td class="pe-3 break-all" :class="u.status === 'duplicate' ? 'text-muted-500' : 'text-rose-600'">{{ u.error }}</td>
                                        <td class="text-right whitespace-nowrap">
                                            <template v-if="u.status === 'failed' || u.status === 'pending'">
                                                <BaseButton v-if="u.status === 'failed'" size="sm" variant="pastel" :loading="busy === 'retry' + u.id" @click="retry(u)">Повторить</BaseButton>
                                                <BaseButton size="sm" color="danger" variant="pastel" class="ml-2" :loading="busy === 'discard' + u.id" @click="discard(u)">Убрать</BaseButton>
                                            </template>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </BaseCard>

                    <!-- FTP: the phone syncs its recordings folder to the CRM -->
                    <BaseCard v-if="ftp" rounded="sm" class="p-4 text-sm">
                        <details>
                            <summary class="cursor-pointer font-semibold">Как подключить телефон по FTP</summary>
                            <div class="mt-3 flex flex-col gap-2">
                                <p>В приложении на телефоне, которое отправляет папку с записями звонков по FTP, укажите:</p>
                                <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                                    <span class="text-muted-500">Сервер</span><code class="select-all break-all">{{ ftp.host }}</code>
                                    <span class="text-muted-500">Порт</span><code class="select-all">{{ ftp.port }}</code>
                                    <span class="text-muted-500">Логин</span><span>любой, например <code>crm</code></span>
                                    <span class="text-muted-500">Пароль</span><span>токен менеджера (выдаётся на этой вкладке)</span>
                                    <span class="text-muted-500">Режим</span><span>пассивный</span>
                                    <span class="text-muted-500">Шифрование</span><span>FTPS (явный TLS, «AUTH TLS»), если приложение его умеет — тогда отметьте у токена «Только FTPS»</span>
                                </div>
                                <p class="text-muted-500">
                                    Номер, направление и время звонка CRM берёт из имени файла (Cube ACR и другие рекордеры).
                                    Один и тот же файл дважды не попадёт; обрезанная копия звонка не задвоит его — остаётся более длинная запись.
                                </p>
                                <p class="text-amber-600">
                                    Без шифрования токен передаётся открытым текстом: такой телефон подключайте только в офисной сети или через VPN.
                                </p>
                            </div>
                        </details>
                    </BaseCard>

                    <BaseCard rounded="sm" class="p-4 text-sm">
                        <details>
                            <summary class="cursor-pointer font-semibold">Загрузка из приложения напрямую (HTTP)</summary>
                            <div class="mt-3 flex flex-col gap-2">
                                <p>Адрес загрузки: <code class="px-1 rounded bg-muted-100 dark:bg-muted-800 break-all">POST {{ uploadUrl }}</code></p>
                                <p>Заголовок: <code class="px-1 rounded bg-muted-100 dark:bg-muted-800">X-Recorder-Token: &lt;токен менеджера&gt;</code></p>
                                <p>
                                    Тело multipart: поле <code>file</code> — аудио (.amr, .mp3, .m4a), и либо поля <code>duration</code> (мс),
                                    <code>number</code>, <code>direction</code> (Incoming / Outgoing), либо поле <code>meta</code> — тот же .json,
                                    что рекордер кладёт рядом с записью.
                                </p>
                            </div>
                        </details>
                    </BaseCard>
                </div>
            </template>
        </BaseTabs>
    </section>
</template>

<script lang="ts" setup>
import AudioPlayer from '~/components/common/AudioPlayer.vue';
import PeriodPicker from '~/components/analytics/PeriodPicker.vue';
import { countOf, formatDateTime, formatPhone } from '~/utils/format';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Запись звонков',
    subject: 'CallRecorder',
});

useHead({ title: 'Запись звонков' });

type TokenRow = { user_id: number; username: string; role: string; has_token: boolean; tls_required?: boolean; issued_at: string | null; last_upload_at: string | null };
type QueueRow = { id: number; user: { id: number; username: string } | null; file_name: string; from_number: string | null; caller_name: string | null; outgoing: boolean; source: string; status: string; error: string | null; received_at: string };
type RecordingRow = { id: number; user: { id: number; username: string } | null; duration: number; outgoing: boolean; path: string; from_number: string | null; created_at: string; deal: { id: number; label: string } | null; contact?: { id: number; username: string } | null };

const ROLES: Record<string, string> = { admin: 'администратор', manager: 'менеджер', agent: 'агент' };
const PAGE_SIZE = 25;

const route = useRoute();
const router = useRouter();
const toast = useToast('GlobalToast');
const config = useRuntimeConfig();
const callsService = useService('calls', { auth: true });

const tabs = [
    { label: 'Записи', value: 'records' },
    { label: 'Подключение телефона', value: 'setup' },
];
const activeTab = ref(route.query.tab === 'setup' ? 'setup' : 'records');
watch(activeTab, (tab) => router.replace({ query: { ...route.query, tab: tab === 'setup' ? 'setup' : undefined } }));

const uploadUrl = computed(() => `${config.public.apiUrl}/calls/upload`);
const tokens = ref<TokenRow[]>([]);
const issued = ref<{ username: string; token: string } | null>(null);
// "host:port" of the FTP receiver (parisahon-ftp); null — it is not set up on this server
const ftp = ref<{ host: string; port: string } | null>(null);
const queue = ref<QueueRow[]>([]);
const queueStatus = ref('failed');
const recordings = ref<{ data: RecordingRow[]; count: number; page: number; limit: number }>({ data: [], count: 0, page: 1, limit: PAGE_SIZE });
const { period, params: periodParams } = useReportPeriod('all');
const filters = reactive({ user_id: '', direction: '', number: '' });
const busy = ref('');
const statusLabel: Record<string, string> = { pending: 'в очереди', done: 'обработан', failed: 'ошибка', discarded: 'убран', duplicate: 'повтор' };

function minutes(ms: number) {
    const s = Math.round((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fail(error: any) {
    toast.show({ type: 'error', message: [error?.data?.message ?? error?.message ?? 'Ошибка'].flat().join('; '), timeout: 4000 });
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
    const params = new URLSearchParams({ page: String(p), limit: String(PAGE_SIZE) });
    if (filters.user_id) params.set('user_id', filters.user_id);
    if (filters.direction) params.set('direction', filters.direction);
    if (filters.number.trim()) params.set('number', filters.number.trim());
    if (periodParams.value.from_date) {
        params.set('from', periodParams.value.from_date);
        params.set('till', periodParams.value.till_date);
    }
    const r = await promiseResult(callsService.get(`recordings?${params}`).exec());
    if (r.ok) recordings.value = r.value as typeof recordings.value; else fail(r.error);
}

let typing: ReturnType<typeof setTimeout> | undefined;
watch(() => [filters.user_id, filters.direction], () => loadRecordings(1));
watch(period, () => loadRecordings(1));
watch(() => filters.number, () => {
    clearTimeout(typing);
    typing = setTimeout(() => loadRecordings(1), 500);
});
watch(queueStatus, loadQueue);

async function issue(row: TokenRow) {
    if (row.has_token && !confirm(`Перевыдать токен для ${row.username}? Старый перестанет работать.`)) return;
    busy.value = 'issue' + row.user_id;
    const r = await promiseResult(callsService.post('/tokens', { user_id: row.user_id }).exec());
    busy.value = '';
    if (!r.ok) return fail(r.error);
    issued.value = { username: row.username, token: (r.value as any).token };
    await loadTokens();
}
async function setTls(row: TokenRow, value: boolean) {
    busy.value = 'tls' + row.user_id;
    const r = await promiseResult(callsService.patch(`tokens/${row.user_id}`, { tls_required: !!value }).exec());
    busy.value = '';
    if (!r.ok) return fail(r.error);
    row.tls_required = !!value;
    toast.show({ type: 'success', message: value ? `${row.username}: вход по FTP только с шифрованием` : `${row.username}: FTP без шифрования снова разрешён`, timeout: 3000 });
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
