<script setup lang="ts">
import Money from '~/components/common/Money.vue';
import type { Deal } from '~/types/deal';
import type { FillerValue } from '~/types/filler';
import type { Product } from '~/types/product';
import { debounce } from '~/utils/search';

const props = defineProps<{
  deal: Deal;
}>();

const productService = useService('products', { auth: true });
const toast = useToast('GlobalToast');
const { run: runProducts, data: products, isLoading: productsLoading } = useAsync<{data: Product[], count: number}>({ data: [], count: 0 });
const openProduct = ref();
const selectedProduct = ref();
const newPrice = ref('');
const newQuantity = ref('1');

// "1 500 000", "2,5" -> a number (NaN for garbage)
const toNumber = (value: unknown) => Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
const lineTotal = (item: { quantity: unknown, price: unknown }) => {
    const sum = toNumber(item.quantity) * toNumber(item.price);
    // with cents: 12.5 m × 1250.40 = 15630
    return Number.isFinite(sum) ? Math.round(sum * 100) / 100 : 0;
};
const total = computed(() => Math.round(props.deal.deal_products.reduce((acc, item) => acc + lineTotal(item), 0) * 100) / 100);
const budget = computed(() => toNumber(props.deal.budget) || 0);

// The budget follows the products while it is empty, 0 or equal to their previous total;
// a budget typed by hand is not touched («Бюджет = итого» sets it on purpose)
watch(total, (now, before) => {
    if (budget.value === 0 || budget.value === before) props.deal.budget = String(now);
});

function setBudget() {
    props.deal.budget = String(total.value);
}

function removeProduct(index: number) {
    props.deal.deal_products.splice(index, 1);
}

// The catalog is searched on the server while the name is typed: every product can be picked,
// not only the first page of it
const searchProducts = (name: string) => runProducts(productService.find({ limit: 30, sort: { name: 1 }, ...(name ? { name } : {}) }).exec());
const onProductInput = debounce((e: Event) => searchProducts((e.target as HTMLInputElement).value.trim()), 300);

function onProductAdd(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const id = Number(formData.get('product[id]'));
    const name = formData.get('product[name]') as string;
    const quantity = String(formData.get('quantity') ?? '').trim();
    const price = String(formData.get('price') ?? '').trim();
    if (!id) return toast.show({message: 'Выберите товар из списка', timeout: 3000, type: 'error'});
    if (!(toNumber(quantity) >= 0) || !(toNumber(price) >= 0) || quantity === '' || price === '') {
        return toast.show({message: 'Цена и количество — числа не меньше нуля', timeout: 3000, type: 'error'});
    }
    props.deal.deal_products.push({
        id,
        quantity: String(toNumber(quantity)),
        price: String(toNumber(price)),
        product: {
            id,
            name,
            product_fillers: [] as FillerValue[]
        },
    });
    target.reset();
    selectedProduct.value = undefined;
    newPrice.value = '';
    newQuantity.value = '1';
    openProduct.value = undefined;
}

onMounted(() => {
    searchProducts('');
});

</script>
<template>
    <section>
        <h3 class="block text-sm font-medium text-muted-900 dark:text-muted-100 mb-2">Товары <span class="text-muted-400">({{ props.deal.deal_products?.length ?? 0 }})</span></h3>
        <div class="flex flex-col space-y-4 mt-2">
            <ul class="flex flex-col gap-1">
                <li v-for="(item, index) in props.deal.deal_products" :key="index">
                    <details class="cursor-pointer group w-full" v-animated-details>
                        <summary
                            class="flex justify-between items-center space-x-2 p-2 rounded-md hover:bg-muted-300 dark:bg-muted-800 dark:hover:bg-muted-700 duration-300 group-open:rounded-b-none group-open:bg-muted-300 group-open:dark:bg-muted-700"
                            @click="openProduct = item.id"
                        >
                            <div class="flex items-center text-muted-900 dark:text-white flex-1 min-w-0 space-x-2">
                                <Icon name="ph:coat-hanger" class="size-5 shrink-0" />
                                <span class="truncate">{{ item.product.name }}</span>
                            </div>
                            <!-- the line: quantity × price -->
                            <span class="shrink-0 text-xs text-muted-600 dark:text-muted-300">
                                {{ toNumber(item.quantity) || 0 }} × <Money :value="toNumber(item.price) || 0" /> = <Money :value="lineTotal(item)" class="font-medium text-muted-900 dark:text-white" />
                            </span>
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
                            <!-- the name belongs to the catalog: it is changed in «Товары», not in a deal -->
                            <BaseInput
                                label="Название"
                                name="name"
                                :model-value="item.product.name"
                                readonly
                            />
                            <BaseInput name="price" label="Цена" inputmode="decimal" v-model="item.price" required />
                            <BaseInput name="quantity" label="Количество" inputmode="decimal" v-model="item.quantity" required />
                        </form>
                    </details>
                </li>
            </ul>
            <div v-if="props.deal.deal_products.length" class="flex flex-wrap items-center justify-between gap-2 px-2 text-sm text-muted-700 dark:text-muted-300">
                <span>Итого по товарам: <Money :value="total" class="font-medium text-muted-900 dark:text-white" /></span>
                <BaseButton v-if="total !== budget" size="sm" type="button" @click="setBudget">
                    Бюджет = итого
                </BaseButton>
            </div>
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
                        :display-value="(product: Product) => product?.name"
                        :properties="{ value: 'id', label: 'name' }"
                        placeholder="Начните вводить название товара"
                        clearable
                        dropdown
                        name="product"
                        @input="onProductInput"
                    />
                    <BaseInput name="price" label="Цена" inputmode="decimal" v-model="newPrice" required />
                    <BaseInput name="quantity" label="Количество" inputmode="decimal" v-model="newQuantity" required />
                    <div class="flex gap-2">
                        <BaseButton type="submit" class="mt-4" v-if="selectedProduct?.id">Сохранить</BaseButton>
                        <BaseButton class="mt-4" variant="pastel" type="button" @click="openProduct = undefined">Отменить</BaseButton>
                    </div>
                </form>
            </details>
        </div>
    </section>
</template>
