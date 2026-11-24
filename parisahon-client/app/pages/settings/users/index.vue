<template>
    <div class="flex flex-col gap-6">
        <div>
            <h1 class="text-xl">Пользователи</h1>
            <h2 class="text-sm text-gray-500">
                Сотрудники CRM: вход, роль, группа и права. Клиенты (контрагенты) ведутся в разделе
                <NuxtLink to="/lists/contacts" class="text-primary-500 hover:underline">Списки → Контакты</NuxtLink>.
            </h2>
        </div>
        <BaseMessage v-if="blindCount" type="warning" :closable="false">
            {{ blindText }}
        </BaseMessage>
        <div class="flex flex-wrap gap-3 justify-between items-center">
            <div class="flex flex-wrap items-center gap-3">
                <DateSelect
                    v-model:start="dateFilter.start"
                    v-model:end="dateFilter.end"
                    label="Дата создания"
                />
                <BaseSelect v-model="roleFilter" name="role" :classes="{wrapper: 'w-44'}">
                    <option value="">Все роли</option>
                    <option value="admin">Администраторы</option>
                    <option value="manager">Менеджеры</option>
                    <option value="agent">Агенты</option>
                </BaseSelect>
                <PerPageSelect v-model="perPage" />
            </div>
            <BaseButton color="primary" :to="{name: 'settings-users-id', params: {id: 'new'}}">
                Новый сотрудник
            </BaseButton>
        </div>
        <div>
            <BaseInput
                v-model="search"
                :classes="{wrapper: 'w-full'}"
                icon="ph:list-magnifying-glass"
                placeholder="Поиск по имени, почте или телефону"
                size="lg"
            />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="pageRows"
                :loading="isLoading"
                :error="loadError"
                :row-link="(item) => ({name: 'settings-users-id', params: {id: item.id}})"
                :empty-text="filtersOn ? 'Никого не нашлось: измените поиск или фильтры' : 'Пока нет сотрудников'"
                class="flex-auto"
                id="users"
                @retry="load"
            >
                <template #rights="{item}">
                    <div v-if="blindSpot(item)" class="flex flex-col items-start gap-1.5 whitespace-normal">
                        <span class="text-xs font-medium text-danger-600 dark:text-danger-400">
                            {{ blindSpot(item) === 'nothing' ? 'Нет прав — сотрудник ничего не видит' : 'Не видит даже свои сделки' }}
                        </span>
                        <BaseButton
                            size="sm"
                            type="button"
                            :loading="pendingId === item.id"
                            @click="giveStandardRights(item)"
                        >
                            Выдать стандартные права
                        </BaseButton>
                    </div>
                    <span v-else>{{ rightsOf(item) }}</span>
                </template>
                <template #actions="{item}">
                    <BaseButtonIcon size="sm" :to="{name: 'settings-users-id', params: {id: item.id}}">
                        <Icon
                            class="w-5 h-5"
                            name="ph:pencil-simple"
                        />
                    </BaseButtonIcon>
                </template>
            </BaseTable>
            <BasePagination
                v-if="filtered.length > perPage"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="filtered.length"
                :max-links-displayed="10"
                shape="rounded"
            />
        </div>
    </div>
</template>

<script lang="ts" setup>
import moment from 'moment';

import BaseTable from '~/components/common/BaseTable.vue';
import DateSelect from '~/components/common/DateSelect.vue';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import {type Column} from '~/components/common/types';
import type { User } from '~/types/user';
import { accessFromUser, blindSpot } from '~/utils/casl';
import { russianDecline } from '~/utils/text';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Пользователи',
    subject: 'User',
    roles: ['admin'],
});

useHead({
    title: 'Пользователи'
});

const route = useRoute();
const app = useAppConfig();
const toast = useToast('GlobalToast');
const usersService = useService('users', {auth: true});
const authService = useService('auth', {auth: true});

const ROLE_NAMES: Record<string, string> = {admin: 'Администратор', manager: 'Менеджер', agent: 'Агент'};

const search = ref('');
const roleFilter = ref('');
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const dateFilter = reactive({start: '', end: ''});
const sortBy = ref<Record<string, number>>({username: 1});
const staff = ref<User[]>([]);
const isLoading = ref(false);
const loadError = ref<string | null>(null);
const pendingId = ref<number | null>(null);

const columns: Column<User>[] = [
    {label: 'Имя', name: 'username', sortable: true, resizable: true, rowAnchor: true, mobile: 'title', subtitle: (u) => u.email},
    {label: 'Роль', name: 'role', enums: ROLE_NAMES, resizable: true},
    {label: 'Группа', name: 'group', field: (u) => u.group?.name ?? 'без группы', resizable: true},
    {label: 'Права', name: 'rights', resizable: true},
    {label: 'Телефон', name: 'phone', phone: true, resizable: true},
    {label: 'Дата создания', name: 'created_at', sortable: true, dateFormat: 'MMM Do, HH:mm', resizable: true},
    {label: '', name: 'actions', headerStyle: {width: '60px'}},
];

/**
 * GET /users/staff: every employee (admin, manager, agent) with the group and the rights — no customer
 * contacts, which /users mixed in (the first pages were all «Контр Агент»). Staff are few, so the
 * search, the filters, the order and the pages are applied here.
 */
async function load() {
    isLoading.value = true;
    loadError.value = null;
    try {
        const response = await usersService.get<{ data: User[] }>('staff').exec();
        staff.value = response?.data ?? [];
    } catch (e: any) {
        loadError.value = e?.message || 'Не удалось загрузить сотрудников';
    } finally {
        isLoading.value = false;
    }
}

const SCOPE_WORDS: Record<string, string> = {none: 'нет', own: 'свои', group: 'группы', all: 'все'};
const SAME_SCOPE: Record<string, string> = {own: 'Свои записи', group: 'Записи группы', all: 'Все записи', none: 'Нет записей'};

/** What the employee sees, in words (the levels as the API applies them, utils/casl.ts accessFromUser). */
function rightsOf(user: User): string {
    if (user.role === 'admin') return 'Полный доступ';
    if (user.role === 'manager') return 'Все записи';
    const {scopes, mail, file} = accessFromUser(user);
    const views = [scopes.deal.view, scopes.company.view, scopes.contact.view];
    const records = views.every((v) => v === views[0])
        ? SAME_SCOPE[views[0]]
        : `Сделки: ${SCOPE_WORDS[scopes.deal.view]}, компании: ${SCOPE_WORDS[scopes.company.view]}, контакты: ${SCOPE_WORDS[scopes.contact.view]}`;
    return [records, !mail && 'без почты', !file && 'без раздела «Файлы»'].filter(Boolean).join(' · ');
}

function digits(value: unknown): string {
    return String(value ?? '').replace(/\D/g, '');
}

const filtersOn = computed(() => !!(search.value.trim() || roleFilter.value || dateFilter.start || dateFilter.end));

const filtered = computed(() => {
    const text = search.value.trim().toLowerCase();
    const phone = digits(text);
    const from = dateFilter.start ? moment(dateFilter.start) : null;
    const till = dateFilter.end ? moment(dateFilter.end) : null;
    const rows = staff.value.filter((u) => {
        if (roleFilter.value && u.role !== roleFilter.value) return false;
        if (from && moment(u.created_at).isBefore(from)) return false;
        if (till && moment(u.created_at).isAfter(till)) return false;
        if (!text) return true;
        return String(u.username ?? '').toLowerCase().includes(text)
            || String(u.email ?? '').toLowerCase().includes(text)
            || (phone.length >= 3 && digits(u.phone).includes(phone));
    });
    const [column, direction] = Object.entries(sortBy.value)[0] ?? ['username', 1];
    const value = (u: User) => (column === 'created_at' ? moment(u.created_at).valueOf() : String((u as any)[column] ?? '').toLowerCase());
    return rows.sort((a, b) => {
        const x = value(a);
        const y = value(b);
        return (x < y ? -1 : x > y ? 1 : a.id - b.id) * (direction === -1 ? -1 : 1);
    });
});

const pageRows = computed(() => filtered.value.slice((currentPage.value - 1) * perPage.value, currentPage.value * perPage.value));

// agents whose card hides everything, or even their own deals (ACL-15): existing cards are not changed by
// themselves — the admin gives the standard rights with one button
const blindCount = computed(() => staff.value.filter((u) => blindSpot(u)).length);
const blindText = computed(() => {
    const n = blindCount.value;
    return `${n} ${russianDecline(n, 'сотрудник', 'сотрудника', 'сотрудников')} без прав на просмотр: `
        + `${n === 1 ? 'он не видит' : 'они не видят'} ничего или даже свои сделки, в том числе переданные коллегами. `
        + 'Кнопка «Выдать стандартные права» в строке открывает свои сделки, компании, контакты и задачи.';
});

// POST /auth/standard-rights/:id: own deals, companies, contacts and tasks; the mail and file switches stay
async function giveStandardRights(user: User) {
    pendingId.value = user.id;
    try {
        const result = await authService.post<{ permissions: User['permissions'] }>(`standard-rights/${user.id}`, {}).exec();
        user.permissions = result.permissions;
        toast.show({message: `${user.username}: выданы стандартные права — свои сделки, компании, контакты и задачи`, timeout: 4000, type: 'success'});
    } catch (e: any) {
        // useService(): `message` is already the human Russian text
        const message = e?.message || e?.data?.message || 'Не удалось выдать права';
        toast.show({message: Array.isArray(message) ? message.join('; ') : String(message), timeout: 4000, type: 'error'});
    } finally {
        pendingId.value = null;
    }
}

watch([search, roleFilter, perPage, () => dateFilter.start, () => dateFilter.end], () => {
    currentPage.value = 1;
});
onMounted(load);
</script>
