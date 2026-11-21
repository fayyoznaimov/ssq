import { ref } from 'vue';

import { useToken } from '~/composables/useService';
import { asyncPool } from '~/utils/async-pool';

const noop = () => { };

type ProgressData = {
    value: number;
    max: number;
    percent: number;
    done: boolean;
}

export function uploadRequest<T>(url: string, {
    body,
    method,
    onProgress = noop,
    onDone = noop,
    headers,
    signal
}: {
    method?: string;
    onProgress?: (data: ProgressData) => void;
    onDone?: (data: T) => any;
    body: any;
    headers?: Record<string, string>;
    signal?: AbortSignal;
}) {
    return new Promise<T>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.responseType = 'json';

        xhr.addEventListener('loadend', () => {
            if (xhr.readyState === 4) {
                if (xhr.status >= 400) reject(xhr.response);
                else {
                    resolve(xhr.response as T);
                    onDone(xhr.response as T);
                }
            }
        });

        xhr.addEventListener('abort', () => reject('Aborted'));
        xhr.addEventListener('error', reject);
        xhr.upload.addEventListener('error', reject);
        xhr.upload.addEventListener('load', (e) => {
            onProgress({ value: e.loaded, max: e.total, percent: (e.loaded / e.total) * 100, done: true });
        });
        xhr.upload.addEventListener('loadstart', (e) => {
            onProgress({ value: 0, max: e.total, percent: 0, done: false });
        });
        xhr.upload.addEventListener('progress', (e) => {
            onProgress({ value: e.loaded, max: e.total, percent: (e.loaded / e.total) * 100, done: false });
        });

        xhr.open(method || 'POST', url, true);

        if (headers) {
            for (const key in headers) {
                xhr.setRequestHeader(key, headers[key]);
            }
        }

        signal?.addEventListener('abort', () => xhr.abort());
        xhr.send(body);
    });
}

export type UseUploadProps<T> = {
    onProgress?: (file: UploadFile, data: ProgressData) => void;
    onDone?: (file: UploadFile, data: T) => any;
    onSuccess?: (results: any[]) => void,
    service: string;
    removeOnDone?: boolean;
}

function genId(prefix = 'temp') {
    const rand = Math.random().toString(32).slice(2);
    return prefix + '-' + rand;
}

export type UploadFile = {
    temp_id: string;
    size: number;
    name: string;
    type: string;
    controller: AbortController;
    raw: File;
    progress: ProgressData;
}

export function useUpload<T>(props: UseUploadProps<T> = { service: '', removeOnDone: true }) {
    const error = ref();
    const loading = ref();
    const uploading = ref<UploadFile[]>([]);

    const cleanup = () => {
        error.value = undefined;
        loading.value = false;
        uploading.value = [];
    };

    const uploadTo = (url: string) => {
        return async (file: UploadFile): Promise<any> => {
            if (!url) throw new Error('no url to upload');
            const formData  = new FormData();
            formData.append('files', file.raw);
                
            const result = await uploadRequest<T>(url, {
                body: formData,
                method: 'POST',
                signal: file.controller.signal,
                headers: {
                    'Authorization': `Bearer ${useToken()}` 
                },
                onProgress: (data) => {
                    if (props.onProgress) props.onProgress(file, data);
                    uploading.value = uploading.value.map((item) => item.temp_id === file.temp_id ? ({ ...item, progress: data }) : item);
                },
                onDone: (response) => {
                    if (props.onDone) props.onDone(file, response);
                    uploading.value = uploading.value.filter((item) => item.temp_id !== file.temp_id);
                }
            });

            return result;
        };
    };

    const upload = async (url: string, files: FileList | File[]) => {
        const fullUrl = (useApiUrl() + (props.service?.[0] === '/' ? props.service : '/' + props.service)) + url;
        try {
            loading.value = true;
            const uploadInput = [];
            for (const file of files) {
                const id = genId();
                const controller = new AbortController();
                controller.signal.addEventListener('abort', () => {
                    uploading.value = uploading.value.filter((item) => item.temp_id !== id);
                });

                uploadInput.push({
                    temp_id: id,
                    controller,
                    type: file.type,
                    size: file.size,
                    name: file.name,
                    raw: file,
                    progress: { value: 0, max: 0, percent: 0, done: false }
                });
            }

            uploading.value = uploadInput;

            const results: T[] = [];
            for await (const result of asyncPool(10, uploadInput, uploadTo(fullUrl))) {
                results.push(result);
            }

            if (props.onSuccess) props.onSuccess(results);
            return results;
        } catch (err: any) {
            error.value = err;
        } finally {
            loading.value = false;
        }
    };

    return { upload, loading, error, uploading, cleanup };
}


