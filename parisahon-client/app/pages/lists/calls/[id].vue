<template>
    <div>
        <header class="mb-5">
            <h1 class="text-xl">
                Записи звонков {{ user.username }}
            </h1>
            <h2 class="text-sm text-gray-500">
                Звонки с телефона сотрудника: клиент, сделка, длительность
            </h2>
        </header>

        <main class="flex flex-col gap-4">
            <div class="flex flex-wrap items-end gap-2 text-sm">
                <input
                    v-model="filters.from"
                    type="date"
                    class="rounded-md border border-muted-300 dark:border-muted-700 bg-transparent px-2 py-1"
                    @change="reload"
                >
                <input
                    v-model="filters.till"
                    type="date"
                    class="rounded-md border border-muted-300 dark:border-muted-700 bg-transparent px-2 py-1"
                    @change="reload"
                >
                <input
                    v-model="filters.number"
                    placeholder="номер"
                    class="rounded-md border border-muted-300 dark:border-muted-700 bg-transparent px-2 py-1 w-36"
                    @change="reload"
                >
                <span
                    v-if="!loading"
                    class="text-muted-500"
                >Записей: {{ recordings.count }}</span>
            </div>

            <Transition
                name="fade"
                mode="out-in"
            >
                <ul v-if="loading">
                    <li>
                        <BasePlaceload class="h-5 w-[200px] rounded mb-4" />
                        <BasePlaceload class="h-16 rounded" />
                    </li>
                </ul>

                <ul
                    v-else-if="recordings.data.length > 0"
                    class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700"
                >
                    <li
                        v-for="r in recordings.data"
                        :key="r.id"
                        class="py-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4"
                    >
                        <div class="text-sm lg:w-80 shrink-0 flex flex-col gap-0.5 min-w-0">
                            <div class="flex items-center gap-2">
                                <span :title="r.outgoing ? 'исходящий' : 'входящий'">{{ r.outgoing ? '↗' : '↙' }}</span>
                                <time>{{ formatDate(r.created_at, "DD.MM.YYYY, HH:mm") }}</time>
                                <span class="text-muted-500">· {{ minutes(r.duration) }}</span>
                            </div>
                            <div class="text-muted-500 break-words">
                                <NuxtLink
                                    v-if="r.contact"
                                    :to="`/lists/contacts/${r.contact.id}`"
                                    class="underline"
                                >{{ r.contact.username }}</NuxtLink>
                                <span v-else>клиент не найден</span>
                                <span v-if="r.from_number"> · {{ r.from_number }}</span>
                            </div>
                            <NuxtLink
                                v-if="r.deal"
                                :to="`/deals/${r.deal.id}`"
                                class="text-primary-600 underline break-words"
                            >{{ r.deal.label }}</NuxtLink>
                            <div
                                v-else
                                class="flex flex-wrap items-center gap-2"
                            >
                                <span class="text-muted-400">нет в сделках</span>
                                <BaseButton
                                    v-if="r.from_number"
                                    size="sm"
                                    color="primary"
                                    variant="pastel"
                                    :loading="busy === r.id"
                                    @click="createDeal(r)"
                                >
                                    Создать сделку
                                </BaseButton>
                            </div>
                        </div>
                        <AudioPlayer
                            :src="r.path"
                            class="flex-1"
                        />
                    </li>
                </ul>

                <BasePlaceholderPage
                    v-else
                    title="Нет записей"
                    subtitle="С телефона этого сотрудника звонки пока не загружены (или ничего не подходит под фильтр)."
                />
            </Transition>

            <BasePagination
                v-if="recordings.count > recordings.limit"
                :current-page="recordings.page"
                :item-per-page="recordings.limit"
                :total-items="recordings.count"
                :max-links-displayed="7"
                shape="rounded"
                @update:current-page="load"
            />
        </main>
    </div>
</template>

<script lang="ts" setup>
import AudioPlayer from "~/components/common/AudioPlayer.vue";
import { type User, UserRole } from "~/types/user";

// one call as GET /calls/staff/:id gives it (CallsService.staffRecordings)
interface CallRow {
    id: number;
    created_at: string;
    duration: number;
    outgoing: boolean;
    path: string;
    from_number: string | null;
    contact: { id: number; username: string } | null;
    deal: { id: number; label: string } | null;
}

const PAGE_SIZE = 25;

const route = useRoute();
const toast = useToast("GlobalToast");
const userService = useService("users", { auth: true });
const callsService = useService("calls", { auth: true });
const staffId = computed(() => String(route.params.id));

const { data: user, run: runUser, isLoading: userLoading } = useAsync<User>({ role: UserRole.Agent } as User);
runUser(userService.get(staffId.value).exec());

const recordings = ref<{ data: CallRow[]; count: number; page: number; limit: number }>({ data: [], count: 0, page: 1, limit: PAGE_SIZE });
const recordingsLoading = ref(true);
const filters = reactive({ from: "", till: "", number: "" });
const busy = ref<number | null>(null);

const loading = computed(() => userLoading.value || recordingsLoading.value);

function fail(error: any) {
    toast.show({ type: "error", message: [error?.data?.message ?? error?.message ?? "Ошибка"].flat().join("; "), timeout: 4000 });
}

function minutes(ms: number) {
    const s = Math.round((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function load(page = 1) {
    const query: Record<string, any> = { page, limit: PAGE_SIZE };
    for (const [key, value] of Object.entries(filters)) if (value) query[key] = value;
    const r = await promiseResult(callsService.get(`staff/${staffId.value}`, query).exec());
    recordingsLoading.value = false;
    if (r.ok) recordings.value = r.value as typeof recordings.value;
    else fail(r.error);
}

function reload() {
    load(1);
}

// a call that is in no deal: the client with that number (found or created) and their deal, with every earlier call of that number
async function createDeal(row: CallRow) {
    busy.value = row.id;
    const r = await promiseResult(callsService.post(`staff/${staffId.value}/recordings/${row.id}/deal`, {}).exec());
    busy.value = null;
    if (!r.ok) return fail(r.error);
    const v = r.value as { deal: { id: number; label: string }; created_deal: boolean; linked: number };
    const what = v.created_deal ? "Сделка создана" : "Запись добавлена в сделку";
    toast.show({ type: "success", message: `${what}: ${v.deal.label}` + (v.linked > 1 ? ` (звонков: ${v.linked})` : ""), timeout: 4000 });
    await load(recordings.value.page);
}

load();
// a new call from the phone: the list follows by itself
useLive((changes) => {
    if (liveTouches(changes, "calls")) load(recordings.value.page);
}, 2000);

useHead({
    title: "Звонки"
});

definePageMeta({
    authRoute: true,
    layout: "account",
    verbose: "Звонки"
});
</script>
