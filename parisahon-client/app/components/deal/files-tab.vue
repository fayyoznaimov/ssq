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
        <BasePlaceload v-if="filesLoading" v-for="index in 6" :key="index" class="h-12 w-full rounded" />
        <ul>
            <li v-for="file in files.data" :key="file.id" class="flex items-center space-x-2 p-2">
                <Icon :name="getFileIcon(file.name)" class="bg-muted-200 dark:bg-muted-700 text-muted-600 dark:text-muted-200 p-1.5 size-10 rounded-md shrink-0"/>
                <div class="flex flex-col text-sm flex-1 min-w-0">
                    <a class="text-muted-900 dark:text-white underline underline-offset-2 break-words" :href="uploadUrl(file.path)" target="_blank" rel="noopener">
                        {{ file.name }}
                    </a>
                    <span class="text-muted-600 dark:text-muted-400">{{ file.uploaded_by?.username || 'Неизвестно' }}</span>
                </div>
                <BaseButtonClose
                    size="sm"
                    rounded="full"
                    color="danger"
                    class="shrink-0"
                    :disabled="deleting[file.id]"
                    :loading="deleting[file.id]"
                    @click="() => removeFile(file.id)"
                />
            </li>
            <li v-if="uploading.length" v-for="file in uploading" :key="file.temp_id" class="flex items-center space-x-2 p-2">
                <Icon :name="getFileIcon(file.name)" class="bg-muted-200 dark:bg-muted-700 text-muted-600 dark:text-muted-200 p-1.5 size-10 rounded-md shrink-0"/>
                <div class="flex flex-col text-sm flex-1 min-w-0">
                    <span class="text-muted-900 dark:text-white break-words">
                        {{ file.name }}
                    </span>
                    <span class="text-muted-600 dark:text-muted-400">{{ Math.floor(file.progress.percent) }}%</span>
                </div>
            </li>
        </ul>
    </div>
</template>
<script setup lang="ts">
import { onMounted } from 'vue';
import { useRoute } from 'vue-router';

import { useAsync } from '~/composables/useAsync';
import { useService } from '~/composables/useService';
import { type UploadFile,useUpload } from '~/composables/useUpload';
import type { DealFile } from '~/types/deal';
import { getFileIcon, MAX_UPLOAD_MB, uploadUrl } from '~/utils/files';
import { promiseResult } from '~/utils/result';

const dealService = useService('deals', { auth: true });
const route = useRoute();
const { run: runFiles, isLoading: filesLoading, data: files } = useAsync<{data: DealFile[]}>({ data: [] });
const { runAsync: runDelete } = useAsync();
const deleting = ref<Record<number, number>>({});
const toast = useToast('GlobalToast');
const fileForm = ref();

function onDone(file: UploadFile, uploaded: DealFile[]) {
    files.value.data.push(...uploaded);
}

const { upload, uploading, error: uploadError } = useUpload({
    service: 'deals', 
    onDone, 
});

async function removeFile(id: number) {
    deleting.value[id] = 1;
    const result = await promiseResult(runDelete(dealService.remove(route.params.id + '/files/' + id).exec()));
    if (result.ok) files.value.data = files.value.data.filter((file) => file.id !== id);
    else toast.show({ message: result.error.message, timeout: 3000, type: 'error' });
    deleting.value[id] = 0;
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
    runFiles(dealService.get(`${route.params.id}/files`).exec());
}

onMounted(() => {
    runFiles(dealService.get(`${route.params.id}/files`).exec());
});

</script>
