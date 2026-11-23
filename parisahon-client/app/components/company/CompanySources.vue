<template>
    <!--  FILES: of every deal of the company (its own and its contacts'), newest first  -->
    <section
        v-if="list === 'files'"
        class="flex flex-col gap-3"
    >
        <template v-if="loading.files && !files.length">
            <BasePlaceload
                v-for="n in 3"
                :key="n"
                class="h-12 w-full rounded-md"
            />
        </template>
        <BasePlaceholderPage
            v-else-if="error"
            title="Файлы не загрузились"
            :subtitle="error"
        />
        <BasePlaceholderPage
            v-else-if="loaded && !files.length"
            title="Нет файлов"
            subtitle="В сделках компании и её контактов пока нет файлов."
        />
        <ul
            v-else
            class="flex flex-col gap-2"
        >
            <li
                v-for="file in files"
                :key="file.id"
                class="flex items-center space-x-2 p-2"
            >
                <Icon
                    :name="getFileIcon(file.name || file.path)"
                    class="bg-muted-200 dark:bg-muted-700 text-muted-600 dark:text-muted-200 p-1.5 size-10 rounded-md shrink-0"
                />
                <div class="flex flex-col text-sm flex-1 min-w-0">
                    <p
                        class="text-muted-900 dark:text-white underline underline-offset-2 cursor-pointer break-words"
                        @click="download(file)"
                    >
                        {{ file.name || file.path }}
                    </p>
                    <p class="text-xs text-muted-500 dark:text-muted-400 break-words">
                        <NuxtLink
                            :to="`/deals/${file.deal}`"
                            class="hover:underline"
                        >
                            {{ file.deal_label || `Сделка №${file.deal}` }}
                        </NuxtLink>
                        <template v-if="file.created_at">
                            · {{ dateText(file.created_at) }}
                        </template>
                    </p>
                </div>
            </li>
        </ul>
        <BaseButton
            v-if="more.files"
            size="sm"
            :loading="loading.files"
            @click="load('files')"
        >
            Показать ещё
        </BaseButton>
    </section>

    <!--  CALLS: recordings of the company's deals, contacts and phones, newest first  -->
    <section
        v-else-if="list === 'recordings'"
        class="flex flex-col gap-3"
    >
        <template v-if="loading.recordings && !recordings.length">
            <BasePlaceload
                v-for="n in 3"
                :key="n"
                class="h-16 w-full rounded-md"
            />
        </template>
        <BasePlaceholderPage
            v-else-if="error"
            title="Звонки не загрузились"
            :subtitle="error"
        />
        <BasePlaceholderPage
            v-else-if="loaded && !recordings.length"
            title="Нет записей"
            subtitle="Записей разговоров с этой компанией и её контактами пока нет."
        />
        <ul
            v-else
            class="flex flex-col gap-2"
        >
            <li
                v-for="rec in recordings"
                :key="rec.id"
                class="flex flex-col gap-1 rounded-md bg-muted-100 p-3 dark:bg-muted-900"
            >
                <p class="flex flex-wrap items-center gap-x-2 text-sm text-muted-800 dark:text-muted-100">
                    <Icon
                        :name="rec.outgoing ? 'ph:phone-outgoing' : 'ph:phone-incoming'"
                        class="size-4 shrink-0 text-primary-600 dark:text-primary-300"
                    />
                    <span>{{ rec.outgoing ? "Исходящий" : "Входящий" }}<template v-if="durationText(rec.duration)">, {{ durationText(rec.duration) }}</template></span>
                    <span class="text-muted-500 dark:text-muted-400">{{ dateText(rec.created_at) }}</span>
                </p>
                <p class="text-xs text-muted-500 dark:text-muted-400 break-words">
                    <template v-if="rec.manager">
                        {{ rec.manager.username }}
                    </template>
                    <template v-if="rec.from_number">
                        · {{ rec.from_number }}
                    </template>
                    <template v-if="rec.deal">
                        ·
                        <NuxtLink
                            :to="`/deals/${rec.deal.id}`"
                            class="hover:underline"
                        >
                            {{ rec.deal.label || `Сделка №${rec.deal.id}` }}
                        </NuxtLink>
                    </template>
                </p>
                <audio
                    v-if="rec.path"
                    controls
                    preload="none"
                    class="mt-1 w-full max-w-md"
                    :src="uploadUrl(rec.path)"
                />
            </li>
        </ul>
        <BaseButton
            v-if="more.recordings"
            size="sm"
            :loading="loading.recordings"
            @click="load('recordings')"
        >
            Показать ещё
        </BaseButton>
    </section>
</template>

<script lang="ts" setup>
import type { CompanyCallSource, CompanyFileSource } from "~/types/ctrAgent";
import type { Company } from "~/types/user";
import { downloadFile, getFileIcon, uploadUrl } from "~/utils/files";
import { promiseResult } from "~/utils/result";

// The «Файлы» and «Звонки» tabs of a company: one list each for the whole company
// (GET /companies/:id/sources). Before, they were per contact, one click each, and the calls
// were always empty: a recording belongs to the manager who made it, not to the contact.
const props = defineProps<{
    /** The active tab: "files" shows the files, "recordings" the call recordings, any other nothing. */
    list: string;
    company: Company;
    companyLoading: boolean;
}>();

const PAGE = 50;
const companiesService = useService("companies", { auth: true });
const toast = useToast("GlobalToast");

const files = ref<CompanyFileSource[]>([]);
const recordings = ref<CompanyCallSource[]>([]);
const loading = reactive({ files: false, recordings: false });
const more = reactive({ files: false, recordings: false });
const loaded = ref(false);
const error = ref("");

type Kind = "files" | "recordings";

/** The next page of one list; `fresh`: from the start (the first open, a live change) */
async function load(kind: Kind, fresh = false) {
    const id = props.company?.id;
    if (!id || loading[kind]) return;
    loading[kind] = true;
    const skip = fresh ? 0 : (kind === "files" ? files.value.length : recordings.value.length);
    const result = await promiseResult(
        companiesService.get(`${id}/sources`, { skip, limit: PAGE }).exec()
    );
    loading[kind] = false;
    if (!result.ok) {
        error.value = (result.error as any)?.statusCode === 403 || (result.error as any)?.statusCode === 404
            ? "Нет доступа к этой компании"
            : String((result.error as any)?.message ?? "Ошибка");
        return;
    }
    error.value = "";
    const value = result.value as { files: CompanyFileSource[]; recordings: CompanyCallSource[] };
    const page = (value?.[kind] ?? []) as any[];
    if (kind === "files") files.value = fresh ? page : [...files.value, ...page];
    else recordings.value = fresh ? page : [...recordings.value, ...page];
    more[kind] = page.length === PAGE;
    loaded.value = true;
}

function reload() {
    load("files", true);
    load("recordings", true);
}

// the first time a tab is opened (both lists come in one answer, so the second tab is ready too)
watch(
    () => [props.list, props.company?.id],
    () => {
        if ((props.list === "files" || props.list === "recordings") && props.company?.id && !loaded.value) reload();
    },
    { immediate: true }
);

// new files and calls appear without reloading the page
useLive((changes) => {
    if (!loaded.value) return;
    if (liveTouches(changes, "files") || liveTouches(changes, "calls") || liveTouches(changes, "events")) reload();
}, 1500);

/** 61825 ms -> «1:02» */
function durationText(ms: number | null | undefined) {
    const total = Math.round(Number(ms ?? 0) / 1000);
    if (!Number.isFinite(total) || total <= 0) return "";
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function dateText(value?: string | null) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("ru", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// the name on disk is random: save the file under its own name
async function download(file: { path: string; name?: string }) {
    try {
        await downloadFile(uploadUrl(file.path), file.name);
    } catch (e) {
        toast.show({ message: (e as Error).message, type: "error", timeout: 3000 });
    }
}
</script>
