<template>
    <div class="flex flex-col gap-4 px-10">
        <BaseTabs 
            v-model="activeTab"
            :tabs="[
                { label: 'Общее', value: 'general' },
                { label: 'Настройка', value: 'settings' }
            ]">
            <template #tab="{activeValue}">
                <form v-if="activeValue === 'general'" class="max-w-sm flex flex-col gap-3" @submit.prevent="onSubmit" novalidate>
                    <BaseInput
                        type="text"
                        v-model="product.name"
                        label="Название товара*"
                        name="name"
                        placeholder="пр.: Parisa"
                        icon="ph:buildings"
                        :loading="productLoading"
                        required
                        :error="errors.name"
                        @input="(e: Event) => onChange('name', (e.target as HTMLInputElement).value)"
                    />
                    <!-- the catalogue: the deal suggests the price of one unit instead of asking every time -->
                    <BaseInput
                        v-model="product.sku"
                        type="text"
                        label="Артикул"
                        name="sku"
                        placeholder="пр.: PR-1024"
                        icon="ph:barcode"
                        :loading="productLoading"
                        :error="errors.sku"
                    />
                    <div class="flex gap-3">
                        <BaseInput
                            v-model="product.unit"
                            type="text"
                            label="Единица"
                            name="unit"
                            placeholder="м, кг, шт"
                            :classes="{wrapper: 'w-1/3'}"
                            :loading="productLoading"
                            :error="errors.unit"
                        />
                        <BaseInput
                            v-model="priceText"
                            type="text"
                            inputmode="decimal"
                            label="Цена за единицу"
                            name="price"
                            placeholder="пр.: 12500.50"
                            :classes="{wrapper: 'w-2/3'}"
                            :loading="productLoading"
                            :error="errors.price"
                            @input="(e: Event) => onChange('price', (e.target as HTMLInputElement).value)"
                        />
                    </div>
                    <ul class="flex flex-col gap-3">
                        <li class="flex items-end gap-2" v-for="(filler, idx) in product.product_fillers">
                            <input type="hidden" name="fillers" :value="filler.id">
                            <input type="hidden" :name="`fillers.${filler.id}.${idx}.tempId`" :value="filler.tempId">
                            <input v-if="filler.new" type="hidden" :name="`fillers.${filler.id}.${idx}.new`" value="new" />
                            <BaseInput 
                                :classes="{wrapper: 'w-full', inputWrapper: 'flex gap-2'}" 
                                :label="filler.filler.field" 
                                v-model="filler.value" 
                                :name="`fillers.${filler.id}.${idx}`" 
                                :required="filler.filler.is_required"
                                :error="errors[filler.tempId]"
                                :key="filler.tempId"
                                @input="(e: Event) => onChange(filler.tempId, (e.target as HTMLInputElement).value)"
                            >
                                <template #action>
                                    <BaseButtonIcon rounded="md" @click="() => onAddtionalFillerValue(idx, filler)">
                                        <Icon name="ph:plus" class="size-4" />
                                    </BaseButtonIcon>
                                </template>
                            </BaseInput>
                        </li>
                    </ul>
                    <div class="flex flex-col gap-2 mt-4">
                        <Can I="delete" a="Product">
                            <BaseButton color="danger" v-if="product.id" @click="onDelete" :loading="isLoadingMap.delete" :disabled="isLoadingMap.delete">
                                Удалить
                            </BaseButton>
                        </Can>
                        <Can v-if="!productLoading" :I="product.id ? 'update' : 'create'" a="Product">
                            <BaseButton color="primary" type="submit" :disabled="isLoadingMap.save" :loading="isLoadingMap.save">
                                Сохранить
                            </BaseButton>
                        </Can>
                    </div>
                </form>
                <div v-if="activeValue === 'settings'" class="max-w-sm flex flex-col gap-4">
                    <div class="flex items-center gap-3" v-for="(filler, idx) in fillers.product">
                        <details :open="openFiller === idx" class="w-full">
                            <summary v-show="openFiller !== idx" @click="openFiller = idx">
                                <BaseInput
                                    type="text"
                                    v-model="filler.field"
                                    placeholder="пр.: "
                                    icon="ph:textbox"
                                    :classes="{wrapper: 'w-full'}"
                                    :form="'filler' + filler.id"
                                    name="field"
                                />
                            </summary>
                            <BaseInput
                                type="text"
                                v-model="filler.field"
                                placeholder="пр.: "
                                icon="ph:textbox"
                                :classes="{wrapper: 'w-full'}"
                                :form="'filler' + filler.id"
                                name="field"
                                ref="fieldRefs"
                            />
                            <BaseSwitchThin :form="'filler' + filler.id" name="required" label="Обязательное поле" :classes="{wrapper: 'mt-4 max-w-fit'}" v-model="filler.is_required" />
                            <div class="flex gap-2 mt-4">
                                <form @submit.prevent="onFillerSave" :id="'filler' + filler.id">
                                    <input type="hidden" name="action_id" :value="`save${filler.id}`">
                                    <input type="hidden" name="id" :value="filler.id">
                                    <input type="hidden" name="idx" :value="idx">
                                    <input v-if="filler.id < 0" type="hidden" name="new" value="new">
                                    <BaseButton size="sm" type="submit" :loading="isLoadingMap[`save${filler.id}`]">
                                        Сохранить
                                    </BaseButton>
                                </form>
                                <form @submit.prevent="onFillerDelete">
                                    <input v-if="filler.id < 0" type="hidden" name="new" value="new">
                                    <input type="hidden" name="action_id" :value="`delete${filler.id}`">
                                    <input type="hidden" name="id" :value="filler.id">
                                    <input type="hidden" name="idx" :value="idx">
                                    <BaseButton color="danger" size="sm" type="submit" :loading="isLoadingMap[`delete${filler.id}`]">
                                        Удалить
                                    </BaseButton>
                                </form>
                            </div>
                        </details>
                    </div>
                    <BaseButton v-if="currentUser?.role === UserRole.Admin" variant="pastel" class="w-full" @click="addFiller">
                        <Icon class="size-4 mr-2" name="ph:plus"/>
                        Добавить поле
                    </BaseButton>
                </div>
            </template>
        </BaseTabs>
    </div>
</template>

<script lang="ts" setup>
import { Can } from '@casl/vue';

import type BaseTabs from '~/components/base/BaseTabs.vue';
import { useAsync } from '~/composables/useAsync';
import { useValidation } from '~/composables/useValidation';
import type { Filler, FillerValue } from '~/types/filler';
import type { Product } from '~/types/product';
import { type User, UserRole } from '~/types/user';
import { confirmFillerDelete } from '~/components/company/fillerDelete';
import { optional, required, type Schema, validPattern } from '~/utils/validation';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Новый товар'
});

useHead({
    title: 'Новый товар'
});

let fakeId = -1;
const route = useRoute();
const toast = useToast('GlobalToast');
const productService = useService('products', {auth: true});
const fillersService = useService('fillers', {auth: true});
const currentUser = useState<User>('user');
const openFiller = ref();
const fieldRefs = ref();

const activeTab = ref('general');
const { data: fillers, run: runFillers, isLoading: fillersLoading } = useAsync<{product: Filler[]}>({ product: [] });
const { data: product, run: runProduct, isLoading: productLoading } = useAsync<Product>({});
const { runWithId, isLoadingMap } = useAsync();

const schema: Schema<string> = {
    name: [required('Обязательное поле')],
    // "12 500,50" or 12500.5: a number with at most 2 decimals
    price: [optional(validPattern(/^\d[\d\s]*([.,]\d{1,2})?$/, 'Число, не больше 2 знаков после запятой'))],
};

// the price as typed; the API gets a number (or null: no price)
const priceText = ref('');
watch(() => product.value.price, (price) => {
    priceText.value = price === null || price === undefined ? '' : String(price);
}, { immediate: true });
function priceValue(): number | null {
    const text = priceText.value.replace(/\s/g, '').replace(',', '.');
    return text === '' ? null : Number(text);
}

const {onChange, validate, errors} = useValidation(schema);

function addFiller() {
    if (!fillers.value.product) fillers.value.product = [];
    fillers.value.product.push({
        id: --fakeId,
        field: '',
        target: 'product',
        created_at: new Date().toISOString(),
        is_required: false,
    });
}

function onAddtionalFillerValue(idx: number, filler: FillerValue) {
    let fillerValue = {...filler, id: filler.filler.id, value: '', new: true, tempId: Math.random().toString(32).slice(2)};
    product.value.product_fillers.splice(idx + 1, 0, fillerValue);
    schema[fillerValue.tempId] = [required('Обязательное поле')];
}

async function onFillerSave(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const isNew = formData.get('new');
    const field = formData.get('field');
    const isRequired = formData.get('required') === 'on';
    const idx = Number(formData.get('idx') as string);
    const id = Number(formData.get('id') as string);
    const actionId = formData.get('action_id') as string;

    if (isNew) {
        const result = await promiseResult(runWithId(fillersService.create({ field, target: 'product', is_required: isRequired }).exec(), actionId));
        if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 3000 });
        fillers.value.product.splice(idx, 1, result.value as Filler);
        return;
    }

    const result = await promiseResult(runWithId(fillersService.patch(id, { field, target: 'product', is_required: isRequired }).exec(), actionId));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
}

async function onFillerDelete(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const isNew = formData.get('new');
    const actionId = formData.get('action_id') as string;
    const id = Number(formData.get('id') as string);
    if (isNew) {
        fillers.value.product = fillers.value.product.filter((f) => f.id !== id);
        return;
    }

    // deleting a field deletes its value in every product: say how many, and ask
    if (!(await confirmFillerDelete(fillersService, id))) return;
    const result = await promiseResult(runWithId(fillersService.remove(id).exec(), actionId));
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 3000 });
    fillers.value.product = fillers.value.product.filter((f) => f.id !== id);
}

async function onSubmit(e: Event) {
    const { id, name } = product.value;
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const fillerIds = formData.getAll('fillers');
    const fillersCreate = [];
    const fillers = [];
    const fieldsMap: Record<string, string> = {};

    for (let i = 0, len = fillerIds.length; i < len; i++) {
        const id = fillerIds[i];
        const value = formData.get(`fillers.${id}.${i}`) as string;
        const isNew = formData.get(`fillers.${id}.${i}.new`);
        const tempId = formData.get(`fillers.${id}.${i}.tempId`) as string;
        if (!value) continue;
        if (isNew) fillersCreate.push({ filler_id: Number(id), value });
        else fillers.push({ product_filler_id: Number(id), value });
        fieldsMap[tempId] = value;
    }

    const validationResult = validate({name, price: priceText.value, ...fieldsMap});
    if (!validationResult.valid) return;

    const catalogue = {
        sku: (product.value.sku ?? '').trim() || null,
        unit: (product.value.unit ?? '').trim() || null,
        price: priceValue(),
    };
    let promise;
    if (id) promise = productService.patch(id, { name, ...catalogue, fillers, fillers_create: fillersCreate }).exec();
    else promise = productService.create({ name, ...catalogue, fillers: fillersCreate }).exec();

    const result = await promiseResult(runWithId(promise, 'save'));
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 3000 });
    navigateTo('/lists/products');
}

async function onDelete() {
    // one click used to delete the product
    if (!confirm(`Удалить товар «${product.value.name}»? Он пропадёт из каталога и из выбора товара в сделках.`)) return;
    const result = await promiseResult(runWithId(productService.remove(product.value.id).exec(), 'delete'));
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 3000 });
    navigateTo('/lists/products');
}

watch([fillers, product], () => {
    for (const filler of fillers.value.product || []) {
        if (product.value.product_fillers?.some((cf) => cf.filler.id === filler.id)) continue;
        if (!product.value.product_fillers) product.value.product_fillers = [];
        const fillerValue = {
            id: filler.id,
            value: '',
            filler,
            new: true,
            created_at: new Date().toISOString(),
            tempId: Math.random().toString(32).slice(2)
        };
        product.value.product_fillers.push(fillerValue);
        if (filler.is_required) schema[fillerValue.tempId] = [required('Обязательное поле')];
    }
});

watch(openFiller, () => {
    nextTick(() => {
        fieldRefs.value[openFiller.value].el?.focus();
    });
});

onMounted(() => {
    if (route.params.id !== 'new') runProduct(productService.get(route.params.id as string).exec());
    runFillers(fillersService.find({target: 'product'}).exec());
});

</script>

<style scoped>

</style>
