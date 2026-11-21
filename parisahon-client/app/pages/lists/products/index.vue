<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Товары</h1>
            <h2 class="text-sm text-gray-500">Список товаров</h2>
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
                placeholder="Поиск"
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
import type { Filler } from '~/types/filler';
import {type PaginatedResponse} from '~/types/generics';
import type { Product } from '~/types/product';
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
    const out: Column[] = [{
        label: 'Имя',
        name: 'name',
        resizable: true,
    }];

    for (let i = 0, len = fillers.value.product?.length || 0; i < len; i++) {
        const filler = fillers.value.product[i];
        out.push({
            label: filler.field,
            name: 'name',
            resizable: true,
            field: (product: Product) => product.product_fillers.find((f) => f.filler.id === filler.id)?.value,
        });
    }

    out.push({ label: '', name: 'actions', headerStyle: { width: '100px' }});

    return out;
});

// `{name}` sent the ref object ("[object Object]") instead of the typed text
const searchByName = debounce((value: string) => runProducts(productService.find(value ? {name: value} : {}).exec()), 300);
function fetchProducts() {
    runProducts(productService.find({
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        sort: sortBy.value,
    }).exec());
}

watch(name, searchByName);
watch([currentPage, sortBy, perPage, dateFilter], fetchProducts);
onMounted(() => {
    fetchProducts();
    runFillers(fillersService.find({target: 'product'}).exec());
});
</script>

<style>
</style>
