<script setup lang="ts">
import type { Deal } from '~/types/deal';
import type { FillerValue } from '~/types/filler';
import type { Product } from '~/types/product';

const props = defineProps<{
  deal: Deal;
}>();

const productService = useService('products', { auth: true });
const { run: runProducts, data: products, isLoading: productsLoading } = useAsync<{data: Product[], count: number}>({ data: [], count: 0 });
const openProduct = ref();
const selectedProduct = ref();

function removeProduct(index: number) {
    props.deal.deal_products.splice(index, 1);
}

function nameFilter(query?: string, items?: any[]) {
    if (!query || !items) return items;
    const lowercased = query.toLowerCase();
    const filtered = items.filter((item) => item.name.toLowerCase().includes(lowercased));
    if (!filtered.length) filtered.push({ name: query });
    return filtered;
}

function onProductAdd(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const id = Number(formData.get('product[id]'));
    const name = formData.get('product[name]') as string;
    const quantity = formData.get('quantity') as string;
    const price = formData.get('price') as string;
    props.deal.deal_products.push({
        id,
        quantity,
        price,
        product: {
            id,
            name,
            product_fillers: [] as FillerValue[]
        },
    });
    target.reset();
    openProduct.value = undefined;
}

onMounted(() => {
    runProducts(productService.find({limit: 100}).exec());
});

</script>
<template>
    <section>
        <span class="text-medium text-muted-900">Товары</span>
        <div class="flex flex-col space-y-4 mt-2">
            <ul class="flex flex-col gap-1">
                <li v-for="(item, index) in props.deal.deal_products" :key="index">
                    <details class="cursor-pointer group w-full" v-animated-details>
                        <summary
                            class="flex justify-between items-center space-x-2 p-2 rounded-md hover:bg-muted-300 dark:bg-muted-800 dark:hover:bg-muted-700 duration-300 group-open:rounded-b-none group-open:bg-muted-300 group-open:dark:bg-muted-700"
                            @click="openProduct = item.id"
                        >
                            <div class="flex items-center text-muted-900 dark:text-white flex-1 space-x-2">
                                <Icon name="ph:coat-hanger" class="size-5" />
                                <span>{{ item.product.name }}</span>
                            </div>
                            <BaseButtonClose
                                size="sm"
                                rounded="full"
                                color="default"
                                @click="(e: Event) => {
                                    e.stopPropagation();
                                    removeProduct(index);
                                }"
                            />
                        </summary>
                        <form
                            :id="'product-' + item.id"
                            class="bg-muted-200 p-2 rounded-b-md content dark:bg-muted-800"
                        >
                            <BaseInput
                                label="Название"
                                name="name"
                                v-model="item.product.name"
                            />
                            <BaseInput name="price" label="Цена" v-model="item.price" required />
                            <BaseInput name="quantity" label="Количество" v-model="item.quantity" required />
                        </form>
                    </details>
                </li>
            </ul>
            <details :open="openProduct === 'new'" class="group">
                <summary class="group-open:hidden">
                    <BaseButton @click="openProduct = 'new'">
                        <Icon name="ph:plus" class="size-4 mr-2" />
                        Добавить товар
                    </BaseButton>
                </summary>
                <form @submit.prevent="onProductAdd">
                    <BaseAutocomplete
                        v-model="selectedProduct"
                        :items="products.data"
                        :loading="productsLoading"
                        :display-value="(product: Product) => product.name"
                        :filter-value="nameFilter"
                        :properties="{ value: 'id', label: 'name' }"
                        placeholder="Выберите товар"
                        clearable
                        dropdown
                        name="product"
                    />
                    <BaseInput name="price" label="Цена" required />
                    <BaseInput name="quantity" label="Количество" required />
                    <div class="flex gap-2">
                        <BaseButton type="submit" class="mt-4" v-if="selectedProduct?.id">Сохранить</BaseButton>
                        <BaseButton class="mt-4" variant="pastel" @click="openProduct = undefined">Отменить</BaseButton>
                    </div>
                </form>
            </details>
        </div>
    </section>
</template>