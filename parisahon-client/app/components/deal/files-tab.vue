<template>
    <div class="flex flex-col space-y-4">
        <form ref="fileForm">
            <BaseInputFileHeadless
                v-slot="{ open }"
                :change="onFileChange"
                multiple
            >
                <BaseButton color="primary" class="w-full" @click="open">
                    <Icon
                        name="ph:plus"
                        class="mr-2"
                        size="18"
                    />
                    Добавить
                </BaseButton>
            </BaseInputFileHeadless>
        </form>
        <BasePlaceload v-if="filesLoading && !files.data.length" v-for="index in 6" :key="index" class="h-12 w-full rounded" />
        <p v-else-if="!files.data.length && !uploading.length" class="text-center text-xs text-muted-600 dark:text-muted-300">Файлов нет</p>
        <ul>
            <li v-if="uploading.length" v-for="file in uploading" :key="file.temp_id" class="flex items-center space-x-2 p-2">
                <Icon :name="getFileIcon(file.name)" class="bg-muted-200 dark:bg-muted-700 text-muted-600 dark:text-muted-200 p-1.5 size-10 rounded-md shrink-0"/>
                <div class="flex flex-col text-sm flex-1 min-w-0">
                    <span class="text-muted-900 dark:text-white break-words">
                        {{ file.name }}
                    </span>
                    <span class="text-muted-600 dark:text-muted-400">{{ Math.floor(file.progress.percent) }}%</span>
                </div>
            </li>
            <!-- the newest first: a fresh photo or invoice of the client is on top -->
            <li v-for="file in files.data" :key="file.id" class="flex items-center space-x-2 p-2">
                <Icon :name="getFileIcon(file.name)" class="bg-muted-200 dark:bg-muted-700 text-muted-600 dark:text-muted-200 p-1.5 size-10 rounded-md shrink-0"/>
                <div class="flex flex-col text-sm flex-1 min-w-0">
                    <a class="text-muted-900 dark:text-white underline underline-offset-2 break-words" :href="uploadUrl(file.path)" target="_blank" rel="noopener">
                        {{ file.name }}
                    </a>
                    <span class="text-xs text-muted-600 dark:text-muted-400">
                        {{ sourceOf(file) }}<template v-if="file.created_at"> · {{ moment(file.created_at).format('DD.MM.YY HH:mm') }}</template> · {{ file.uploaded_by?.username || 'Неизвестно' }}
                    </span>
                </div>
                <BaseButtonClose
                    size="sm"
                    rounded="full"
                    color="danger"
                    class="shrink-0"
                    :disabled="deleting[file.id]"
                    :loading="deleting[file.id]"
                    @click="() => removeFile(file)"
                />
            </li>
        </ul>
        <div v-if="files.count > files.data.length" class="flex flex-col items-center gap-1">
            <span class="text-xs text-muted-600 dark:text-muted-300">Показано {{ files.data.length }} из {{ files.count }}</span>
            <BaseButton size="sm" :loading="loadingMore" :disabled="loadingMore" @click="loadMore">Показать ещё</BaseButton>
        </div>
    </div>
</template>
<script setup lang="ts">
import moment from 'moment';
import { onMounted } from 'vue';
import { useRoute } from 'vue-router';

import { useAsync } from '~/composables/useAsync';
import { useService } from '~/composables/useService';
import { type UploadFile,useUpload } from '~/composables/useUpload';
import type { DealFile } from '~/types/deal';
import { getFileIcon, MAX_UPLOAD_MB, uploadUrl } from '~/utils/files';
import { promiseResult } from '~/utils/result';

// what GET /deals/:id/files gives besides the DealFile fields
type TabFile = DealFile & { from?: string; created_at?: string };

const PAGE = 30;
const SOURCES: Record<string, string> = {
    from_messages: 'Из сообщения',
    from_emails: 'Из письма',
    uploaded_from_files_tab: 'Загружен',
    from_comments: 'Из примечания',
};

const dealService = useService('deals', { auth: true });
const route = useRoute();
const { run: runFiles, isLoading: filesLoading, data: files } = useAsync<{data: TabFile[], count: number}>({ data: [], count: 0 });
const { runAsync: runDelete } = useAsync();
const deleting = ref<Record<number, number>>({});
const loadingMore = ref(false);
const toast = useToast('GlobalToast');
const fileForm = ref();

const sourceOf = (file: TabFile) => SOURCES[file.from ?? ''] ?? 'Файл';

// newest first, page by page (the API gave 25 of the oldest and nothing more)
const filesPage = (skip: number) => dealService.get(`${route.params.id}/files`, { sort: { id: -1 }, limit: PAGE, skip }).exec();

function fetchFiles() {
    runFiles(filesPage(0));
}

async function loadMore() {
    loadingMore.value = true;
    const result = await promiseResult(filesPage(files.value.data.length));
    loadingMore.value = false;
    if (!result.ok) return toast.show({ message: result.error.message, timeout: 3000, type: 'error' });
    const known = new Set(files.value.data.map((file) => file.id));
    const page = result.value as { data: TabFile[], count: number };
    files.value.data.push(...page.data.filter((file) => !known.has(file.id)));
    files.value.count = page.count;
}

function onDone(file: UploadFile, uploaded: DealFile[]) {
    files.value.data.unshift(...(uploaded as TabFile[]).map((item) => ({ ...item, from: item.from ?? 'uploaded_from_files_tab', created_at: item.created_at ?? new Date().toISOString() })));
    files.value.count += uploaded.length;
}

const { upload, uploading, error: uploadError } = useUpload({
    service: 'deals',
    onDone,
});

async function removeFile(file: TabFile) {
    const from = sourceOf(file).toLowerCase();
    const note = file.from === 'from_messages' || file.from === 'from_emails'
        ? ` Он пропадёт из вкладки, сообщение или письмо в истории останется.`
        : '';
    if (!confirm(`Удалить файл «${file.name}» (${from}) из сделки?${note}`)) return;
    deleting.value[file.id] = 1;
    const result = await promiseResult(runDelete(dealService.remove(route.params.id + '/files/' + file.id).exec()));
    if (result.ok) {
        files.value.data = files.value.data.filter((item) => item.id !== file.id);
        files.value.count = Math.max(0, files.value.count - 1);
    }
    else toast.show({ message: result.error.message, timeout: 3000, type: 'error' });
    deleting.value[file.id] = 0;
}

async function onFileChange(selected: FileList) {
    const chosen = Array.from(selected ?? []);
    fileForm.value.reset();
    const tooBig = chosen.filter((file) => file.size > MAX_UPLOAD_MB * 1024 * 1024);
    if (tooBig.length) {
        toast.show({ message: `Больше ${MAX_UPLOAD_MB} МБ, не загружено: ${tooBig.map((f) => f.name).join(', ')}`, timeout: 5000, type: 'error' });
    }
    const toUpload = chosen.filter((file) => !tooBig.includes(file));
    if (!toUpload.length) return;

    uploadError.value = undefined;
    await upload(`/${route.params.id}/files`, toUpload);
    if (!uploadError.value) return;

    // the upload failed: say why and show the list as the server has it
    const error = uploadError.value;
    const message = error?.statusCode === 413
        ? `Файл больше ${MAX_UPLOAD_MB} МБ — не загружен`
        : (Array.isArray(error?.message) ? error.message.join(', ') : error?.message) || 'Не удалось загрузить файл';
    toast.show({ message, timeout: 4000, type: 'error' });
    uploading.value = [];
    fetchFiles();
}

// files that came with a message or a letter while the tab is open
useLive((changes) => {
    if (liveTouches(changes, 'files') && !loadingMore.value && files.value.data.length <= PAGE) fetchFiles();
}, 1000);

onMounted(() => {
    fetchFiles();
});

</script>
