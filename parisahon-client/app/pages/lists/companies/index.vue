<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Компании</h1>
            <h2 class="text-sm text-gray-500">Список компаний</h2>
        </div>
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex items-center gap-4">
                <PerPageSelect v-model="perPage" />
                <TairoPopover fixed size="lg">
                    <BaseButton><Icon name="ph:funnel" /></BaseButton>
                    <template #content>
                        <div class="flex items-start flex-col gap-2 p-4">
                            <BaseInput v-model="withDealsAtPeriodStart" type="date" label="Дата первой сделки" :classes="{wrapper: 'w-full'}"/>
                            <BaseInput v-model="withDealsAtPeriodEnd" type="date" label="Дата последней сделки" :classes="{wrapper: 'w-full'}"/>
                            <div class="flex gap-6 mt-2">
                                <BaseSwitchThin label="Без сделок" v-model="noDealsBefore" color="primary" />
                                <BaseSwitchThin label="Старый клиент" v-model="isOld" color="primary" name="is_old" />
                            </div>
                        </div>
                    </template>
                </TairoPopover>
            </div>
            <Can I="create" a="Company">
                <NuxtLink
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
            <BaseInput
                v-model="name"
                icon="ph:list-magnifying-glass"
                placeholder="Поиск"
                size="lg"
            />
        </div>
        <div class="relative overflow-x-auto">
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
import type { Company } from '~/types/user';
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

const route = useRoute();
const app = useAppConfig();
const companiesService = useService('companies', {auth: true});
const fillersService = useService('fillers', {auth: true});

const name = ref('');
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const dateFilter = reactive({start: '', end: ''});
const withDealsAtPeriodEnd = ref();
const withDealsAtPeriodStart = ref();
const isOld = ref();
const noDealsBefore = ref();
const sortBy = ref<Record<string, any>>({id: -1});
const { data: fillers, run: runFillers, isLoading: fillersLoading } = useAsync<{company: Filler[]}>({ company: [] });
const { data: companies, run: runCompanies, isLoading: companiesLoading } = useAsync<PaginatedResponse<Company>>({
    data: [],
    count: 0,
    page_size: perPage.value,
    current_page: 0,
    last_page: 0
});

const columns = computed(() => {
    const out: Column[] = [
        {
            label: 'Название',
            name: 'name',
            resizable: true,
            link(value) {
                return {name: 'lists-companies-id', params: {id: value.id}};
            }
        },
        {
            label: 'Номер телефона',
            name: 'phone',
            resizable: true,
            link(value) {
                return {name: 'lists-companies-id', params: {id: value.id}};
            }
        },
        {
            label: 'Электронная почта',
            name: 'email',
            resizable: true,
            link(value) {
                return {name: 'lists-companies-id', params: {id: value.id}};
            }
        },
        {
            label: 'Кол-во сделок',
            name: 'deal_count',
            resizable: true,
            link(value) {
                return {name: 'lists-companies-id', params: {id: value.id}};
            }
        },
        {
            label: 'LTV',
            name: 'live_time_value',
            resizable: true,
            link(value) {
                return {name: 'lists-companies-id', params: {id: value.id}};
            }
        },
        {
            label: 'Статус',
            name: 'is_old',
            resizable: true,
            link(value) {
                return {name: 'lists-companies-id', params: {id: value.id}};
            },
            field: (company: Company) => {
                if (company.is_old) return 'Старый клиент';
                else return 'Новый клиент';
            }
        },
    ];

    for (const filler of fillers.value.company || []) {
        out.push({
            label: filler.field,
            name: 'name',
            resizable: true,
            link(value) {
                return {name: 'lists-companies-id', params: {id: value.id}};
            },
            field: (company: Company) => company.company_fillers.find((f) => f.filler.id === filler.id)?.value,
        });
    }

    out.push({ label: 'Дата создания', name: 'created_at', dateFormat: 'MMM Do, HH:mm', resizable: true, });
    out.push({ label: '', name: 'actions', headerStyle: { width: '100px' } });

    return out;
});

type QueryParams = {
    skip: number;
    limit: number;
    sort: {[key in string]: string | number}
    with_deals_at_period_end?: string;
    with_deals_at_period_start?: string;
    had_deals_before?: boolean;
    is_old?: boolean;
}

function fetchCompanies() {
    const query: QueryParams = {
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        sort: sortBy.value,
    };
    if (withDealsAtPeriodEnd.value) {
        query.with_deals_at_period_end = withDealsAtPeriodEnd.value;
    }
    if (withDealsAtPeriodStart.value) {
        query.with_deals_at_period_start = withDealsAtPeriodStart.value;
    }

    if (noDealsBefore.value) {
        query.had_deals_before = false;
    }

    if (isOld.value) query.is_old = true;

    runCompanies(companiesService.find(query).exec());
}

const searchByName = debounce((name: string) => runCompanies(companiesService.find({name}).exec()), 300);

watch([currentPage, sortBy, perPage, dateFilter, isOld, noDealsBefore, withDealsAtPeriodEnd, withDealsAtPeriodStart], fetchCompanies);
watch(name, searchByName);
useLive((changes) => { if (liveTouches(changes, 'companies') || liveTouches(changes, 'deals')) fetchCompanies(); }, 1000);

onMounted(() => {
    fetchCompanies(),
    runFillers(fillersService.find({target: 'company'}).exec());
});
</script>

<style>
</style>
