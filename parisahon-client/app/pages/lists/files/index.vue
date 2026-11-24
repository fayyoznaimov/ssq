<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Файлы</h1>
            <!-- the API lists an agent's files only: of the deals they may see, their own uploads, mail attachments with the mail switch -->
            <h2 class="text-sm text-gray-500">{{ limited ? 'Файлы доступных вам сделок и ваши загрузки' : 'Всего: ' + formatNumber(files.count ?? 0, 0, '0') }}</h2>
        </div>
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex items-center gap-4">
                <PerPageSelect v-model="perPage" />
                <TairoPopover fixed size="lg">
                    <BaseButton><Icon name="ph:funnel" /></BaseButton>
                    <template #content>
                        <form class="flex items-start flex-col gap-2 w-full p-4 overflow-hidden" @submit.prevent="reload">
                            <DatePicker 
                                v-model="filters.dates"
                                format="dd-MM-yyyy" 
                                range text-input vertical 
                                :preset-dates="presetDates" 
                                auto-apply 
                                :enable-time-picker="false"
                                model-type="yyyy-MM-dd"
                                :teleport="true"
                                :dark="isDarkMode"
                            >
                                <template #dp-input="{ onInput, value, onBlur, onPaste }">
                                    <BaseInput :value="value" @input="onInput" @blur="onBlur" @paste="onPaste" placeholder="За все время" />
                                </template>
                            </DatePicker>
                            <BaseInput v-model="filters.extensions" :classes="{wrapper: 'w-full'}" placeholder="Типы, пр.: pdf jpg"/>
                            <BaseListbox 
                                :items="fileSources" 
                                :properties="{label: 'label', value: 'id' }"
                                :fixed="true"
                                placeholder="Источник" 
                                v-model="filters.fileSource"
                                :display-value="(source: typeof fileSources[0]) => `Источник: ${source.label}`"
                            />
                            <BaseAutocomplete 
                                placeholder="Кем загружен" 
                                :fixed="true" 
                                :items="employees" 
                                :properties="{label: 'username', value: 'id', sublabel: (u: User)  => u.group?.name}" 
                                dropdown 
                                v-model="filters.uploadedBy"
                                clearable
                                :display-value="(user?: User) => user?.username ? `Загружен: ${user.username}` : ''"
                            />
                            <div class="flex gap-2">
                                <div class="flex items-center gap-1">
                                    <BaseInput v-model="filters.fromBytes" type="number" placeholder="Размер" />
                                    <span>-</span>
                                    <BaseInput v-model="filters.tillBytes" type="number" />
                                </div>
                                <BaseSelect v-model="filters.unit"  :classes="{wrapper: 'shrink-0'}">
                                    <option :value="Unit.MB">МБ</option>
                                    <option :value="Unit.KB">КБ</option>
                                    <option :value="Unit.GB">ГБ</option>
                                    <option :value="Unit.B">Байты</option>
                                </BaseSelect>
                            </div>
                            <BaseButton type="submit">Применить</BaseButton>
                        </form>
                    </template>
                </TairoPopover>
            </div>
        </div>
        <div>
            <Search
                v-model="searchQ"
                :debounce="600"
                :fields="fields"
                :ilike="false"
            />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="files.data"
                :loading="filesLoading"
                class="flex-auto"
                id="files"
            >
                <template #name="{item}: {item: MyFile}">
                    <div class="flex items-center justify-between gap-2 min-w-0">
                        <div class="flex items-center gap-2 min-w-0">
                            <Icon :name="iconOf(item)" class="size-5 shrink-0 text-muted-500" />
                            <div class="flex flex-col min-w-0">
                                <a :href="uploadUrl(item.path)" target="_blank" rel="noopener" class="truncate hover:underline" :title="item.name">{{ titleOf(item) }}</a>
                                <span class="text-xs text-muted-400 truncate">{{ sourceOf(item) }} · {{ sizeOf(item) }}</span>
                            </div>
                        </div>
                        <BaseButtonIcon size="sm" class="shrink-0" @click="download(item)" :disabled="isLoadingMap[item.id]" aria-label="Скачать">
                            <Icon v-if="isLoadingMap[item.id]" name="lucide:loader-circle" class="animate-spin"/>
                            <Icon v-else name="ph:download-simple" />
                        </BaseButtonIcon>
                    </div>
                </template>
                <template #entities="{item}: {item: MyFile}">
                    <div class="flex flex-col gap-0.5">
                        <NuxtLink v-for="deal in dealsOf(item)" :key="deal.id" :to="'/deals/' + deal.id" class="underline truncate">{{ deal.label }}</NuxtLink>
                        <NuxtLink v-if="item.message?.client" :to="'/lists/contacts/' + item.message.client.id" class="text-muted-500 hover:underline truncate">{{ item.message.client.username }}</NuxtLink>
                        <span v-if="!dealsOf(item).length && !item.message?.client" class="text-muted-400">—</span>
                    </div>
                </template>
            </BaseTable>
            <BasePagination
                v-if="files.count / perPage > 1"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="files.count"
                :max-links-displayed="10"
                shape="rounded"
            />
        </div>
    </div>
</template>

<script lang="ts" setup>
import { onMounted } from 'vue';

import DatePicker from '@vuepic/vue-datepicker';
import BaseTable from '~/components/common/BaseTable.vue';
import TairoPopover from '~/components/tairo/TairoPopover.vue';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import Search from '~/components/common/Search.vue';
import {type Column} from '~/components/common/types';
import { useAsync } from '~/composables/useAsync';
import type { PaginatedResponse } from '~/types/generics';
import { FileSource } from '~/types/stage';
import type { MyFile } from '~/types/file';
import moment from 'moment';
import { UserRole, type User } from '~/types/user';
import { Unit, toBytes } from '~/utils/byte';
import { downloadFile, getFileIcon, uploadUrl } from '~/utils/files';
import { formatDateTime, formatNumber } from '~/utils/format';
import { promiseResult } from '~/utils/result';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Файлы',
    subject: 'File'
});

useHead({
    title: 'Файлы'
});

type Filters = {
    dates?: string[];
    fileSource: {
        id: string;
        label: string;
    };
    extensions: string;
    uploadedBy?: User;
    fromBytes: string;
    tillBytes: string;
    unit: Unit;
}

const skipFileSource = {
    id: 'skip',
    label: 'Не учитывать',
}

const initialFilters: Filters = {
    dates: [],
    extensions: '',
    fileSource: skipFileSource,
    unit: Unit.MB,
    fromBytes: '',
    tillBytes: '',
};

const route = useRoute();
const currentUser = useState<User>('user');
const limited = computed(() => currentUser.value?.role === UserRole.Agent);
const app = useAppConfig();
const isDarkMode = useDarkMode();
const fileService = useService('files', {auth: true});
const userService = useService('users', {auth: true});
const toast = useToast('GlobalToast');
const searchQ = ref<Record<string, any>>({});
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const sortBy = ref<Record<string, any>>({id: -1});
const { data: files, run: runFiles, isLoading: filesLoading } = useAsync<PaginatedResponse<MyFile>>({
    data: [],
});

const { run: runUsers, data: users } = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});

const {runWithId, isLoadingMap} = useAsync();

const filters = reactive<Filters>({...initialFilters});

const fields: {key: string, label: string}[] = [
    {
        label: 'Название',
        key: 'name',
    },
]

// [first day, last day], both included (see fetchFiles)
const days = (from: moment.Moment, till: moment.Moment) => [from.format('YYYY-MM-DD'), till.format('YYYY-MM-DD')];
const presetDates = ref([
    { label: 'За сегодня', value: days(moment(), moment()) },
    { label: 'За вчера', value: days(moment().subtract(1, 'day'), moment().subtract(1, 'day')) },
    { label: 'За последние 30 дней', value: days(moment().subtract(29, 'day'), moment()) },
    { label: 'За эту неделю', value: days(moment().startOf('week'), moment().endOf('week')) },
    { label: 'За прошлую неделю', value: days(moment().subtract(1, 'week').startOf('week'), moment().subtract(1, 'week').endOf('week')) },
    { label: 'За этот месяц', value: days(moment().startOf('month'), moment().endOf('month')) },
    { label: 'За прошлый месяц', value: days(moment().subtract(1, 'month').startOf('month'), moment().subtract(1, 'month').endOf('month')) },
    { label: 'За квартал', value: days(moment().startOf('quarter'), moment().endOf('quarter')) },
    { label: 'За этот год', value: days(moment().startOf('year'), moment().endOf('year')) },
]);

const fileSources = [
    skipFileSource,
    {
        id: FileSource.FromComments,
        label: 'Комментарий',
    },
    {
        id: FileSource.FromFilesTab,
        label: 'Вкладка файлов',
    },
    {
        id: FileSource.FromMessages,
        label: 'Сообщение',
    },
    {
        id: FileSource.FromEmails,
        label: 'Почта',
    },
]

const SOURCES: Record<string, string> = {
    [FileSource.FromEmails]: 'Почта',
    [FileSource.FromComments]: 'Комментарий',
    [FileSource.FromFilesTab]: 'Вкладка файлов',
    [FileSource.FromMessages]: 'Сообщение',
};

// the history row that holds the file says more than «Сообщение»: which messenger
const MESSAGE_KINDS: Record<number, string> = { 12: 'Telegram', 16: 'WhatsApp', 5: 'Комментарий' };

function sourceOf(item: MyFile) {
    const kind = item.message ? MESSAGE_KINDS[item.message.type] : undefined;
    if (kind && item.from !== FileSource.FromEmails) return kind;
    return SOURCES[item.from] ?? '—';
}

/** «Голосовое · Akbar · 21 нояб. 2026, 18:36» for the files a messenger names "voice_message", "Photo"... */
const GENERIC_NAMES: Record<string, string> = {
    voice_message: 'Голосовое', voice: 'Голосовое', photo: 'Фото', video_note: 'Видеосообщение',
    video: 'Видео', audio: 'Аудио', sticker: 'Стикер', document: 'Документ', animation: 'Анимация',
};
function titleOf(item: MyFile) {
    const generic = GENERIC_NAMES[String(item.name ?? '').trim().toLowerCase()];
    if (!generic) return item.name || 'Файл';
    const who = item.message?.client?.username || item.uploaded_by?.username;
    return [generic, who, formatDateTime(item.message?.at || item.created_at)].filter(Boolean).join(' · ');
}

function iconOf(item: MyFile) {
    const ext = String(item.extension || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    if (/^\.(jpe?g|png|gif|webp|heic|bmp)$/.test(ext) || name === 'photo') return 'ph:image';
    if (/^\.(mp3|ogg|oga|opus|m4a|wav|amr|aac)$/.test(ext) || name.startsWith('voice')) return 'ph:microphone';
    if (/^\.(mp4|webm|mov|mkv|3gp)$/.test(ext) || name.startsWith('video')) return 'ph:video';
    return getFileIcon(ext ? 'file' + ext : '');
}

function sizeOf(item: MyFile) {
    const n = Number(item.size);
    return n > 0 ? formatBytes(n) : '—';
}

function dealsOf(item: MyFile) {
    const deals: { id: number; label: string }[] = [...(item.deals ?? [])];
    const fromMessage = item.message?.deal;
    if (fromMessage && !deals.some((d) => d.id === fromMessage.id)) deals.push(fromMessage);
    return deals;
}

// the date second, the client and the deal next to it; the name no longer takes half the screen
const columns: Column[] = [
    {
        label: 'Имя',
        name: 'name',
        headerStyle: {
            width: '320px',
            minWidth: '220px'
        },
        resizable: true,
    },
    {
        label: 'Дата',
        name: 'created_at',
        resizable: true,
        field(item: MyFile) {
            return formatDateTime(item.message?.at || item.created_at);
        }
    },
    {
        label: 'Клиент / сделка',
        name: 'entities',
        resizable: true,
    },
    {
        label: 'Источник',
        name: 'from',
        resizable: true,
        field: sourceOf,
    },
    {
        label: 'Кто загрузил',
        name: 'uploaded_by',
        resizable: true,
        field(item) {
            return item.uploaded_by?.username || '—';
        }
    },
    {
        label: 'Размер',
        name: 'size',
        resizable: true,
        field: sizeOf,
    },
    {
        label: 'Тип',
        name: 'extension',
        resizable: true,
        field(item: MyFile) {
            return item.extension ? item.extension.replace(/^\./, '').toUpperCase() : '—';
        }
    },
];

const employees = computed(() => {
    return (users.value.data ?? []).filter((u) => u.role !== UserRole.CtrAgent);
});

function fetchFiles() {
    const query: Record<string, any> = {
        ...searchQ.value,
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        sort: sortBy.value,
    }

    // the API compares created_at > from and < till: till is the day after the last one
    if (filters.dates?.length === 2 && filters.dates[0] && filters.dates[1]) {
        query.created_at_from = filters.dates[0];
        query.created_at_till = moment(filters.dates[1]).add(1, 'day').format('YYYY-MM-DD');
    }

    if (filters.extensions.length) {
        const parts = filters.extensions.split(' ').filter(Boolean);
        if (parts.length) query.with_extensions = parts;
    }

    if (filters.uploadedBy?.id) {
        query.uploaded_by = filters.uploadedBy.id;
    }

    if (filters.fromBytes) {
        query.from_bytes = toBytes(filters.unit, Number(filters.fromBytes));
    }

    if (filters.tillBytes) {
        query.till_bytes = toBytes(filters.unit, Number(filters.tillBytes));
    }

    if (filters.fileSource.id !== 'skip') {
        query.uploaded_from = filters.fileSource.id;
    }

    runFiles(fileService.find(query).exec());
}

// a new search or new filters start from the first page
function reload() {
    if (currentPage.value !== 1) currentPage.value = 1;
    else fetchFiles();
}

async function download(file: MyFile) {
    const result = await promiseResult(runWithId(downloadFile(uploadUrl(file.path), file.name), file.id));
    if (!result.ok) toast.show({message: result.error.message, type: 'error', timeout: 3000});
}

watch(searchQ, reload);
watch([currentPage, sortBy, perPage], fetchFiles);
onMounted(() => {
    fetchFiles();
    // the staff only, by name (GET /users/staff): the first 1000 users mixed them with the contacts
    runUsers(userService.get("staff").exec());
});
</script>

<style>
</style>
