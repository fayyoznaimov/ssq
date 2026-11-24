<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <div>
                <h1 class="text-xl">Аналитика по товарам</h1>
                <h2 class="text-sm text-gray-500">Товары в сделках, созданных за период (удалённые сделки не считаются)</h2>
            </div>
            <PeriodPicker v-model="period" />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="stats.data"
                :loading="isLoading"
                class="flex-auto"
                id="product-analytics"
            >
            </BaseTable>
            <p v-if="!isLoading && !stats.data.length" class="text-sm text-muted-500 mt-2">За этот период в сделках нет товаров.</p>
            <BasePagination
                v-if="stats.count / perPage > 1"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="stats.count"
                :max-links-displayed="10"
                shape="rounded"
            />
        </div>
    </div>
</template>

<script lang="ts" setup>
import { onMounted, watch } from 'vue';

import BaseTable from '~/components/common/BaseTable.vue';
import PeriodPicker from '~/components/analytics/PeriodPicker.vue';
import {type Column} from '~/components/common/types';
import { useAsync } from '~/composables/useAsync';
import {type PaginatedResponse} from '~/types/generics';
import type { ProductStat } from '~/types/product';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'По товарам'
});

useHead({
    title: 'По товарам'
});

const route = useRoute();
const app = useAppConfig();
const statsService = useService('products/statistics', {auth: true});

const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const { data: stats, isLoading, run } = useAsync<PaginatedResponse<ProductStat>>({
    data: [],
    count: 0,
    current_page: 0,
    last_page: 0,
    page_size: perPage.value
});

const sortBy = ref<Record<string, any>>({});
// all time unless a period was chosen here or in another report
const { period, params: periodParams } = useReportPeriod('all');
const columns = ref<Column[]>([
    {
        label: 'Имя',
        name: 'name',
        resizable: true,
    },
    {
        label: 'Кол-во сделок',
        name: 'deal_count',
        sortable: true,
        resizable: true,
    },
    {
        label: 'Средняя цена (шт)',
        name: 'average_price_per_product',
        money: true,
        sortable: true,
        resizable: true,
    },
    {
        label: 'Средняя цена (сделка)',
        name: 'average_price_per_deal',
        money: true,
        sortable: true,
        resizable: true,
    },
    {
        label: 'Сумма продаж',
        name: 'total_price_sold',
        money: true,
        sortable: true,
    },
]);

function fetchStats() {
    run(statsService.find({
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        sort: sortBy.value,
        ...periodParams.value,
    }).exec());
}

watch([currentPage, sortBy, perPage], fetchStats);
// another period starts from the first page
watch(period, () => {
    if (currentPage.value !== 1) currentPage.value = 1;
    else fetchStats();
});
onMounted(fetchStats);

</script>

<style>
</style>
