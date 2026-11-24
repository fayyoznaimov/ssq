<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Товары</h1>
            <h2 class="text-sm text-gray-500">Всего: {{ formatNumber(products.count ?? 0, 0, '0') }}</h2>
        </div>
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex items-center gap-4">
                <DateSelect
                    v-model:start="dateFilter.start"
                    v-model:end="dateFilter.end"
                    label="Дата создания"
                />
                <PerPageSelect v-model="perPage" />
            </div>
            <Can I="create" a="Product">
                <NuxtLink
                    :to="{name: 'lists-products-id', params: {id: 'new'}}"
                    class="border border-gray-300 dark:border-muted-600 rounded-md"
                >
                    <BaseButton color="primary">
                        Новый товар
                    </BaseButton>
                </NuxtLink>
            </Can>
        </div>
        <div>
            <BaseInput
                v-model="name"
                :classes="{wrapper: 'w-full'}"
                icon="ph:list-magnifying-glass"
                placeholder="Название или артикул"
                size="lg"
            />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-if="!fillersLoading"
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="products.data"
                :loading="productsLoading"
                class="flex-auto"
                id="products"
            >
                <template #actions="{item}">
                    <BaseButtonIcon size="sm" :to="{name: 'lists-products-id', params: {id: item.id}}">
                        <Icon
                            class="w-5 h-5"
                            name="ph:pencil-simple"
                        />
                    </BaseButtonIcon>
                </template>
            </BaseTable>
            <BasePagination
                v-if="products.count / perPage > 1"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="products.count"
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
import DateSelect from '~/components/common/DateSelect.vue';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import {type Column} from '~/components/common/types';
import { useAsync } from '~/composables/useAsync';
import { formatNumber } from '~/utils/format';
import type { Filler } from '~/types/filler';
import {type PaginatedResponse} from '~/types/generics';
import type { Product } from '~/types/product';
import moment from 'moment';

import {debounce} from '~/utils/search';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Товары',
    subject: 'Product'
});

useHead({
    title: 'Товары'
});

const route = useRoute();
const app = useAppConfig();
const productService = useService('products', {auth: true});
const fillersService = useService('fillers', {auth: true});

const name = ref('');
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const dateFilter = reactive({start: '', end: ''});
const sortBy = ref<Record<string, any>>({id: -1});
const { data: fillers, run: runFillers, isLoading: fillersLoading } = useAsync<{product: Filler[]}>({ product: [] });
const { data: products, run: runProducts, isLoading: productsLoading } = useAsync<PaginatedResponse<Product>>({
    data: [],
    count: 0,
    current_page: 0,
    last_page: 0,
    page_size: perPage.value
});

const columns = computed(() => {
    const toCard = (product: Product) => ({name: 'lists-products-id', params: {id: product.id}});
    const out: Column[] = [
        { label: 'Имя', name: 'name', resizable: true, sortable: true, link: toCard },
        { label: 'Артикул', name: 'sku', resizable: true, link: toCard, field: (product: Product) => product.sku ?? '' },
        { label: 'Ед.', name: 'unit', link: toCard, field: (product: Product) => product.unit ?? '' },
        // the base price of one unit; empty: not set
        { label: 'Цена', name: 'price', link: toCard, field: (product: Product) => product.price == null ? '' : Number(product.price).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) },
    ];

    for (let i = 0, len = fillers.value.product?.length || 0; i < len; i++) {
        const filler = fillers.value.product[i];
        out.push({
            label: filler.field,
            // a column key of its own (every extra field was "name": the same key twice)
            name: `filler-${filler.id}`,
            resizable: true,
            field: (product: Product) => product.product_fillers?.find((f) => f.filler?.id === filler.id)?.value,
        });
    }

    out.push({ label: '', name: 'actions', headerStyle: { width: '100px' }});

    return out;
});

// The search, the creation date, the page and the sorting go in one request: the search was a request
// of its own (a page change dropped it), and the date was never sent.
function fetchProducts() {
    const query: Record<string, any> = {
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        sort: sortBy.value,
    };
    const text = name.value.trim();
    if (text) query.name = text;
    // local days (the picker gives UTC moments)
    if (dateFilter.start) query.created_from = moment(dateFilter.start).format('YYYY-MM-DD');
    if (dateFilter.end) query.created_till = moment(dateFilter.end).format('YYYY-MM-DD');
    runProducts(productService.find(query).exec());
}

// a new search or date starts from the first page
function fromFirstPage() {
    if (currentPage.value !== 1) currentPage.value = 1;
    else fetchProducts();
}

watch(name, debounce(fromFirstPage, 300));
watch(dateFilter, fromFirstPage);
watch([currentPage, sortBy, perPage], fetchProducts);
onMounted(() => {
    fetchProducts();
    runFillers(fillersService.find({target: 'product'}).exec());
});
</script>

<style>
</style>
