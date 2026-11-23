<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Компании</h1>
            <h2 class="text-sm text-gray-500">
                <template v-if="showTrash">Удалённые компании: {{ trash.count }}. Восстановленная компания возвращается в списки со своими контактами и сделками.</template>
                <template v-else>Список компаний</template>
            </h2>
        </div>
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex items-center gap-4">
                <PerPageSelect v-model="perPage" />
                <TairoPopover v-if="!showTrash" fixed size="lg">
                    <BaseButton><Icon name="ph:funnel" /></BaseButton>
                    <template #content>
                        <div class="flex items-start flex-col gap-2 p-4">
                            <!-- a deal counts when it was open at some moment of the period -->
                            <BaseInput v-model="withDealsAtPeriodStart" type="date" label="Сделки в периоде: с" :classes="{wrapper: 'w-full'}"/>
                            <BaseInput v-model="withDealsAtPeriodEnd" type="date" label="по" :classes="{wrapper: 'w-full'}"/>
                            <div class="flex flex-wrap gap-6 mt-2">
                                <BaseSwitchThin v-model="firstInPeriod" label="Впервые в периоде" color="primary" :disabled="!hasPeriod" />
                                <BaseSwitchThin v-model="noDeals" label="Без сделок" color="primary" />
                                <BaseSwitchThin v-model="isOld" label="Старый клиент" color="primary" name="is_old" />
                            </div>
                            <p class="text-xs text-muted-400 max-w-xs">
                                «Впервые в периоде» — у компании не было сделок до периода. LTV — сумма успешных сделок компании и её контактов.
                            </p>
                        </div>
                    </template>
                </TairoPopover>
                <!-- deleted companies (restore one deleted by mistake): admin and manager -->
                <BaseButton v-if="canRestore" @click="showTrash = !showTrash">
                    <Icon :name="showTrash ? 'ph:arrow-left' : 'ph:trash'" class="me-1.5 size-4" />
                    {{ showTrash ? 'К компаниям' : 'Удалённые' }}
                </BaseButton>
            </div>
            <Can I="create" a="Company">
                <NuxtLink
                    v-if="!showTrash"
                    :to="{name: 'lists-companies-id', params: {id: 'new'}}"
                    class="border border-gray-300 dark:border-muted-600 rounded-md"
                >
                    <BaseButton color="primary">
                        Новая компания
                    </BaseButton>
                </NuxtLink>
            </Can>
        </div>
        <div>
            <!-- the name, ИНН, phone, e-mail, and the names, phones and e-mails of the contacts -->
            <BaseInput
                v-model="search"
                icon="ph:list-magnifying-glass"
                :placeholder="showTrash ? 'Название удалённой компании' : 'Название, ИНН, телефон, почта или контакт'"
                size="lg"
            />
        </div>
        <div v-if="showTrash" class="relative overflow-x-auto">
            <BaseTable
                id="companies-trash"
                v-model:sortBy="trashSortBy"
                :columns="trashColumns"
                :data="trash.data"
                :loading="trashLoading"
                class="flex-auto"
            >
                <template #actions="{item}">
                    <BaseButton size="sm" :loading="isLoadingMap[`restore-${item.id}`]" @click="restore(item)">
                        <Icon name="ph:arrow-counter-clockwise" class="me-1.5 size-4" />
                        Восстановить
                    </BaseButton>
                </template>
            </BaseTable>
            <BasePagination
                v-if="trash.count / perPage > 1"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="trash.count"
                :max-links-displayed="10"
                shape="rounded"
            />
        </div>
        <div v-else class="relative overflow-x-auto">
            <BaseTable
                v-if="!fillersLoading"
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="companies.data"
                :loading="companiesLoading"
                class="flex-auto"
                id="companies"
            >
                <template #actions="{item}">
                    <BaseButtonIcon size="sm" :to="{name: 'lists-companies-id', params: {id: item.id}}">
                        <Icon
                            class="w-5 h-5"
                            name="ph:pencil-simple"
                        />
                    </BaseButtonIcon>
                </template>
            </BaseTable>
            <BasePagination
                v-if="companies.count / perPage > 1"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="companies.count"
                :max-links-displayed="10"
                shape="rounded"
            />
        </div>
    </div>
</template>

<script lang="ts" setup>
import { Can } from '@casl/vue';
import { onMounted } from 'vue';

import BaseTable from '~/components/common/BaseTable.vue';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import {type Column} from '~/components/common/types';
import BaseInput from '~/components/form/BaseInput.vue';
import BaseSwitchThin from '~/components/form/BaseSwitchThin.vue';
import TairoPopover from '~/components/tairo/TairoPopover.vue';
import { useAsync } from '~/composables/useAsync';
import type { Filler } from '~/types/filler';
import {type PaginatedResponse} from '~/types/generics';
import { type Company, type User, UserRole } from '~/types/user';
import {debounce} from '~/utils/search';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Компании',
    subject: 'Company'
});

useHead({
    title: 'Компании'
});

type DeletedCompany = {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    inn: string | null;
    deleted_at: string;
    contact_count: number;
    deal_count: number;
};

const route = useRoute();
const app = useAppConfig();
const toast = useToast();
const currentUser = useState<User>('user');
const companiesService = useService('companies', {auth: true});
const fillersService = useService('fillers', {auth: true});
const { runWithId, isLoadingMap } = useAsync();

const search = ref('');
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const withDealsAtPeriodEnd = ref();
const withDealsAtPeriodStart = ref();
const isOld = ref();
const noDeals = ref();
const firstInPeriod = ref();
const sortBy = ref<Record<string, any>>({id: -1});
const showTrash = ref(false);
const trashSortBy = ref<Record<string, any>>({});
const hasPeriod = computed(() => !!(withDealsAtPeriodStart.value || withDealsAtPeriodEnd.value));
const canRestore = computed(() => [UserRole.Admin, UserRole.Manager].includes(currentUser.value?.role as UserRole));

const { data: fillers, run: runFillers, isLoading: fillersLoading } = useAsync<{company: Filler[]}>({ company: [] });
const { data: companies, run: runCompanies, isLoading: companiesLoading } = useAsync<PaginatedResponse<Company>>({
    data: [],
    count: 0,
    page_size: perPage.value,
    current_page: 0,
    last_page: 0
});
const { data: trash, run: runTrash, isLoading: trashLoading } = useAsync<PaginatedResponse<DeletedCompany>>({
    data: [],
    count: 0,
    page_size: perPage.value,
    current_page: 0,
    last_page: 0
});

const toCard = (value: Company) => ({name: 'lists-companies-id', params: {id: value.id}});

const columns = computed(() => {
    const out: Column[] = [
        { label: 'Название', name: 'name', resizable: true, sortable: true, link: toCard },
        { label: 'Номер телефона', name: 'phone', resizable: true, sortable: true, link: toCard },
        { label: 'Электронная почта', name: 'email', resizable: true, sortable: true, link: toCard },
        { label: 'Кол-во сделок', name: 'deal_count', resizable: true, sortable: true, link: toCard },
        // the successful deals of the company and of its contacts, as in the card
        { label: 'LTV', name: 'live_time_value', resizable: true, sortable: true, money: true, link: toCard },
        {
            label: 'Статус',
            name: 'is_old',
            resizable: true,
            sortable: true,
            link: toCard,
            field: (company: Company) => {
                if (company.is_old) return 'Старый клиент';
                else return 'Новый клиент';
            }
        },
    ];

    for (const filler of fillers.value.company || []) {
        out.push({
            label: filler.field,
            // a column key of its own (every extra field was "name": the same key twice)
            name: `filler-${filler.id}`,
            resizable: true,
            link: toCard,
            field: (company: Company) => company.company_fillers?.find((f) => f.filler?.id === filler.id)?.value,
        });
    }

    out.push({ label: 'Дата создания', name: 'created_at', dateFormat: 'MMM Do, HH:mm', resizable: true, sortable: true });
    out.push({ label: '', name: 'actions', headerStyle: { width: '100px' } });

    return out;
});

const trashColumns: Column[] = [
    { label: 'Название', name: 'name', resizable: true },
    { label: 'Номер телефона', name: 'phone', resizable: true },
    { label: 'ИНН', name: 'inn', resizable: true },
    { label: 'Контактов', name: 'contact_count' },
    { label: 'Сделок', name: 'deal_count' },
    { label: 'Удалена', name: 'deleted_at', dateFormat: 'DD.MM.YYYY HH:mm' },
    { label: '', name: 'actions', headerStyle: { width: '160px' } },
];

type QueryParams = {
    skip: number;
    limit: number;
    sort: {[key in string]: string | number}
    q?: string;
    with_deals_at_period_end?: string;
    with_deals_at_period_start?: string;
    had_deals_before?: boolean;
    no_deals?: boolean;
    is_old?: boolean;
}

// The search, the filters, the page and the sorting go in one request: the search was a request of
// its own, and a page change, a filter or a live update replaced its result with the whole list.
function fetchCompanies() {
    if (showTrash.value) return fetchTrash();
    const query: QueryParams = {
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        sort: sortBy.value,
    };
    const text = search.value.trim();
    if (text) query.q = text;
    if (withDealsAtPeriodEnd.value) {
        query.with_deals_at_period_end = withDealsAtPeriodEnd.value;
    }
    if (withDealsAtPeriodStart.value) {
        query.with_deals_at_period_start = withDealsAtPeriodStart.value;
    }
    // "no deals before the period" needs a period (the API answered 400 without one)
    if (firstInPeriod.value && hasPeriod.value) query.had_deals_before = false;
    if (noDeals.value) query.no_deals = true;

    if (isOld.value) query.is_old = true;

    runCompanies(companiesService.find(query).exec());
}

function fetchTrash() {
    const query: Record<string, any> = {
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
    };
    const text = search.value.trim();
    if (text) query.q = text;
    runTrash(companiesService.get('trash', query).exec());
}

async function restore(company: DeletedCompany) {
    if (!confirm(`Восстановить компанию «${company.name}»?`)) return;
    const result = await promiseResult(
        runWithId(companiesService.patch(`${company.id}/restore`, {}).exec(), `restore-${company.id}`)
    );
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 4000 });
    toast.show({ message: `Компания «${company.name}» восстановлена`, type: 'success', timeout: 3000 });
    fetchTrash();
}

// a new search, filter or view starts from the first page
function fromFirstPage() {
    if (currentPage.value !== 1) currentPage.value = 1;
    else fetchCompanies();
}

watch([currentPage, sortBy, perPage], fetchCompanies);
watch([isOld, noDeals, firstInPeriod, withDealsAtPeriodEnd, withDealsAtPeriodStart, showTrash], fromFirstPage);
watch(search, debounce(fromFirstPage, 400));
// the companies changed (a deal changes the numbers only: the list is not reloaded on every deal)
useLive((changes) => { if (liveTouches(changes, 'companies')) fetchCompanies(); }, 1000);

onMounted(() => {
    fetchCompanies();
    runFillers(fillersService.find({target: 'company'}).exec());
});
</script>

<style>
</style>
