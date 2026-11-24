<template>
    <section>
        <header class="mb-5">
            <h1 class="text-xl">
                Записи звонков
            </h1>
            <h2 class="text-sm text-gray-500">
                {{ seesAll ? 'Звонки всех сотрудников: клиент, сделка, направление, длительность' : 'Ваши звонки: клиент, сделка, направление, длительность' }}
            </h2>
        </header>

        <main class="flex flex-col gap-4">
            <div class="flex flex-wrap items-center gap-2">
                <BaseSelect
                    v-if="seesAll"
                    v-model="filters.user_id"
                    :classes="{ wrapper: 'w-full sm:w-56' }"
                    aria-label="Сотрудник"
                >
                    <option value="">Все сотрудники</option>
                    <option v-for="u in staff" :key="u.id" :value="String(u.id)">{{ u.username }}</option>
                </BaseSelect>
                <PeriodPicker v-model="period" />
                <BaseSelect
                    v-model="filters.direction"
                    :classes="{ wrapper: 'w-full sm:w-44' }"
                    aria-label="Направление"
                >
                    <option value="">Все звонки</option>
                    <option value="in">Входящие</option>
                    <option value="out">Исходящие</option>
                </BaseSelect>
                <BaseInput
                    v-model="filters.number"
                    icon="ph:magnifying-glass"
                    placeholder="Номер"
                    :classes="{ wrapper: 'w-full sm:w-44' }"
                />
                <span v-if="!loading" class="text-sm text-muted-500">{{ countOf(calls.count, 'звонок', 'звонка', 'звонков') }}</span>
            </div>

            <Transition name="fade" mode="out-in">
                <ul v-if="loading">
                    <li>
                        <BasePlaceload class="h-5 w-[200px] rounded mb-4" />
                        <BasePlaceload class="h-16 rounded" />
                    </li>
                </ul>

                <ul
                    v-else-if="calls.data.length > 0"
                    class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700"
                >
                    <li
                        v-for="r in calls.data"
                        :key="r.id"
                        class="py-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4"
                    >
                        <div class="text-sm lg:w-96 shrink-0 flex flex-col gap-0.5 min-w-0">
                            <div class="flex flex-wrap items-center gap-x-2">
                                <Icon
                                    :name="r.outgoing ? 'ph:phone-outgoing' : 'ph:phone-incoming'"
                                    class="size-4 shrink-0"
                                    :class="r.outgoing ? 'text-primary-500' : 'text-success-500'"
                                />
                                <span class="font-medium">{{ r.outgoing ? 'Исходящий' : 'Входящий' }}</span>
                                <time class="text-muted-500">{{ formatDateTime(r.created_at) }}</time>
                                <span class="text-muted-500">· {{ minutes(r.duration) }}</span>
                            </div>
                            <div class="text-muted-500 break-words">
                                <span v-if="seesAll && r.user">{{ r.user.username }} · </span>
                                <NuxtLink
                                    v-if="r.contact"
                                    :to="`/lists/contacts/${r.contact.id}`"
                                    class="underline"
                                >{{ r.contact.username }}</NuxtLink>
                                <span v-else>клиент не найден</span>
                                <template v-if="r.from_number">
                                    · <a :href="'tel:' + r.from_number.replace(/[^\d+]/g, '')" class="hover:underline">{{ formatPhone(r.from_number) }}</a>
                                </template>
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
                                    v-if="r.from_number && r.user"
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
                            :duration-ms="r.duration"
                            class="flex-1"
                        />
                    </li>
                </ul>

                <BasePlaceholderPage
                    v-else
                    title="Нет записей"
                    :subtitle="emptyText"
                />
            </Transition>

            <BasePagination
                v-if="calls.count > calls.limit"
                :current-page="calls.page"
                :item-per-page="calls.limit"
                :total-items="calls.count"
                :max-links-displayed="7"
                shape="rounded"
                @update:current-page="load"
            />
        </main>
    </section>
</template>

<script lang="ts" setup>
import AudioPlayer from "~/components/common/AudioPlayer.vue";
import PeriodPicker from "~/components/analytics/PeriodPicker.vue";
import { type User, UserRole } from "~/types/user";
import { countOf, formatDateTime, formatPhone } from "~/utils/format";

// one call as GET /calls/list gives it (CallsService.listCalls)
interface CallRow {
    id: number;
    created_at: string;
    duration: number;
    outgoing: boolean;
    path: string;
    from_number: string | null;
    user: { id: number; username: string } | null;
    contact: { id: number; username: string } | null;
    deal: { id: number; label: string } | null;
}

const PAGE_SIZE = 25;

const route = useRoute();
const router = useRouter();
const toast = useToast("GlobalToast");
const callsService = useService("calls", { auth: true });
const userService = useService("users", { auth: true });
const currentUser = useState<User>("user");
// admin and manager see everybody's calls (and choose a person); anybody else their own (the API decides the same)
const seesAll = computed(() => currentUser.value?.role === UserRole.Admin || currentUser.value?.role === UserRole.Manager);

// the period: all time unless chosen (?from=&to=, as the reports keep it)
const { period, params: periodParams } = useReportPeriod("all");
const filters = reactive({
    user_id: String(route.query.user_id ?? ""),
    direction: ["in", "out"].includes(String(route.query.direction)) ? String(route.query.direction) : "",
    number: String(route.query.number ?? ""),
});

const calls = ref<{ data: CallRow[]; count: number; page: number; limit: number }>({ data: [], count: 0, page: 1, limit: PAGE_SIZE });
const loading = ref(true);
const busy = ref<number | null>(null);
const staff = ref<User[]>([]);

const emptyText = computed(() =>
    filters.user_id || filters.direction || filters.number || period.value
        ? "Под эти фильтры звонков нет."
        : "Записи приходят с телефона сотрудника по FTP или через приложение записи; настройка — Настройки → Звонки.",
);

function fail(error: any) {
    toast.show({ type: "error", message: [error?.data?.message ?? error?.message ?? "Ошибка"].flat().join("; "), timeout: 4000 });
}

/** 95000 ms -> «1:35», 3 725 000 -> «1:02:05» */
function minutes(ms: number) {
    const s = Math.round((ms || 0) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

async function load(page = 1) {
    const query: Record<string, any> = { page, limit: PAGE_SIZE };
    if (periodParams.value.from_date) {
        query.from = periodParams.value.from_date;
        query.till = periodParams.value.till_date;
    }
    if (filters.direction) query.direction = filters.direction;
    if (filters.number.trim()) query.number = filters.number.trim();
    if (seesAll.value && filters.user_id) query.user_id = filters.user_id;
    const r = await promiseResult(callsService.get("list", query).exec());
    loading.value = false;
    if (r.ok) calls.value = r.value as typeof calls.value;
    else fail(r.error);
}

let typing: ReturnType<typeof setTimeout> | undefined;
watch(() => [filters.user_id, filters.direction], () => {
    router.replace({ query: { ...route.query, user_id: filters.user_id || undefined, direction: filters.direction || undefined } });
    load(1);
});
watch(() => filters.number, () => {
    clearTimeout(typing);
    typing = setTimeout(() => load(1), 500);
});
watch(period, () => load(1));

// «Создать сделку»: the client with that number (found or created) and their deal, with every earlier call of that number
async function createDeal(row: CallRow) {
    if (!row.user) return;
    busy.value = row.id;
    const r = await promiseResult(callsService.post(`staff/${row.user.id}/recordings/${row.id}/deal`, {}).exec());
    busy.value = null;
    if (!r.ok) return fail(r.error);
    const v = r.value as { deal: { id: number; label: string }; created_deal: boolean; linked: number };
    const what = v.created_deal ? "Сделка создана" : "Запись добавлена в сделку";
    toast.show({ type: "success", message: `${what}: ${v.deal.label}` + (v.linked > 1 ? ` (звонков: ${v.linked})` : ""), timeout: 4000 });
    await load(calls.value.page);
}

onMounted(async () => {
    load();
    if (seesAll.value) {
        const r = await promiseResult(userService.get("staff").exec());
        if (r.ok) {
            const value = r.value as any;
            staff.value = (Array.isArray(value) ? value : value?.data ?? []) as User[];
        }
    }
});
// a new call from the phone: the list follows by itself
useLive((changes) => {
    if (liveTouches(changes, "calls")) load(calls.value.page);
}, 2000);

useHead({
    title: "Записи звонков",
});

definePageMeta({
    authRoute: true,
    layout: "account",
    verbose: "Записи звонков",
});
</script>
