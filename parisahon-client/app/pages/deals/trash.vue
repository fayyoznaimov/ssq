<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
                <h1 class="text-xl">Корзина</h1>
                <h2 class="text-sm text-gray-500">
                    Удалённые сделки: {{ trash.count }}.
                    Восстановленная сделка возвращается в свой этап со всей историей и задачами.
                </h2>
            </div>
            <div class="flex flex-wrap items-center gap-3">
                <NuxtLink to="/deals">
                    <BaseButton>
                        <Icon name="ph:arrow-left" class="me-1.5 size-4" />
                        К сделкам
                    </BaseButton>
                </NuxtLink>
                <BaseButton
                    v-if="isAdmin"
                    color="danger"
                    :disabled="!trash.count"
                    :loading="isLoadingMap.empty"
                    @click="emptyConfirmation.open({description: `Все сделки в корзине (${trash.count}) будут удалены навсегда вместе с историей, задачами и файлами. Восстановить их будет нельзя.`})"
                >
                    <Icon name="ph:trash" class="me-1.5 size-4" />
                    Очистить корзину
                </BaseButton>
            </div>
        </div>
        <div class="flex flex-wrap items-center gap-4">
            <BaseInput
                v-model="search"
                :classes="{wrapper: 'flex-1 min-w-[12rem]'}"
                icon="ph:list-magnifying-glass"
                placeholder="Название или номер сделки"
                size="lg"
            />
            <PerPageSelect v-model="perPage" />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                v-model:sortBy="sortBy"
                :columns="columns"
                :data="trash.data"
                :loading="isLoading"
                class="flex-auto"
                id="deals-trash"
            >
                <template #display_id="{item}">
                    <span class="text-muted-500">№{{ item.display_id }}</span>
                </template>
                <template #label="{item}">
                    <span class="font-medium text-muted-800 dark:text-muted-100">{{ item.label }}</span>
                </template>
                <template #deleted_at="{item}">
                    <div>{{ formatDate(item.deleted_at, 'DD.MM.YYYY HH:mm') }}</div>
                    <div class="text-muted-400 text-sm">{{ item.deleted_by?.username || '—' }}</div>
                </template>
                <template #actions="{item}">
                    <div class="flex items-center justify-end gap-2">
                        <BaseButton
                            size="sm"
                            :loading="isLoadingMap['restore' + item.id]"
                            @click="restore(item)"
                        >
                            <Icon name="ph:arrow-counter-clockwise" class="me-1 size-4" />
                            Восстановить
                        </BaseButton>
                        <BaseButtonIcon
                            v-if="isAdmin"
                            size="sm"
                            title="Удалить навсегда"
                            :loading="isLoadingMap['purge' + item.id]"
                            @click="askPurge(item)"
                        >
                            <Icon name="ph:trash" class="size-4 text-red-600" />
                        </BaseButtonIcon>
                    </div>
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
        <Confirmation
            id="PurgeDealConfirmation"
            title="Удалить навсегда"
            description="Сделка будет удалена навсегда."
            :on-confirm="purge"
        />
        <Confirmation
            id="EmptyTrashConfirmation"
            title="Очистить корзину"
            description="Все сделки в корзине будут удалены навсегда."
            :on-confirm="emptyTrash"
        />
    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import Confirmation from '~/components/common/Confirmation.vue';
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import {type Column} from '~/components/common/types';
import {useAsync} from '~/composables/useAsync';
import type { Deal } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';
import { type User, UserRole } from '~/types/user';
import { ability } from '~/utils/casl';
import { formatDate } from '~/utils/common';
import { promiseResult } from '~/utils/result';
import { debounce } from '~/utils/search';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Корзина сделок',
    subject: 'Deal'
});

useHead({
    title: 'Корзина сделок'
});

// The trash is for those who may delete deals (the API answers 403 to everybody else)
if (!ability.can('delete', 'Deal')) {
    await navigateTo('/403');
}

const app = useAppConfig();
const toast = useToast('GlobalToast');
const user = useState<User>('user');
const dealsService = useService('deals', {auth: true});
const purgeConfirmation = useModal('PurgeDealConfirmation');
const emptyConfirmation = useModal('EmptyTrashConfirmation');

const isAdmin = computed(() => user.value?.role === UserRole.Admin);
const search = ref('');
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(1);
const sortBy = ref<Record<string, any>>({deleted_at: -1});
const pending = ref<Deal | null>(null);

const { run, isLoading, data: trash } = useAsync<PaginatedResponse<Deal>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: perPage.value,
    current_page: 0,
});
const { runWithId, isLoadingMap } = useAsync();

const columns: Column<Deal>[] = [
    { label: 'Номер', name: 'display_id', sortable: true, headerStyle: { width: '90px' } },
    // on a phone the card is headed by the name, with «Восстановить» under it
    { label: 'Название сделки', name: 'label', sortable: true, resizable: true, mobile: 'title', maxWidth: 360 },
    { label: 'Этап', name: 'stage', field: (deal) => escapeHtml(deal.stage?.name), stage: (deal) => deal.stage, resizable: true },
    { label: 'Бюджет', name: 'budget', money: true, field: (deal) => Number(deal.budget), resizable: true },
    { label: 'Ответственный', name: 'agent', field: (deal) => escapeHtml(deal.agent?.username), resizable: true },
    { label: 'Компания', name: 'company', field: (deal) => escapeHtml(deal.company?.name), resizable: true },
    { label: 'Удалена', name: 'deleted_at', sortable: true, headerStyle: { minWidth: '160px' } },
    { label: '', name: 'actions', headerStyle: { width: '220px' } },
];

// BaseTable shows `field` as text (it is not HTML any more): escaping here showed «&amp;» in a name
function escapeHtml(value?: string | null): string {
    return value || '—';
}

function errorMessage(error: any): string {
    const message = error?.data?.message ?? error?.message;
    return Array.isArray(message) ? message.join(', ') : (message || 'Ошибка');
}

function fetchTrash() {
    const query: Record<string, any> = {
        limit: perPage.value,
        skip: (currentPage.value - 1) * perPage.value,
        sort: sortBy.value,
    };
    if (search.value.trim()) query.search = search.value.trim();
    run(dealsService.get('trash', query).exec());
}

// After an action the page may become empty: step back to the last page that exists
function refresh() {
    const lastPage = Math.max(1, Math.ceil((trash.value.count - 1) / perPage.value));
    if (currentPage.value > lastPage) currentPage.value = lastPage; // the watcher fetches
    else fetchTrash();
}

async function restore(deal: Deal) {
    const result = await promiseResult(runWithId(dealsService.post(`trash/${deal.id}/restore`, {}).exec(), 'restore' + deal.id));
    if (!result.ok) return toast.show({type: 'error', message: errorMessage(result.error), timeout: 4000});
    const stage = (result.value as Deal)?.stage?.name;
    toast.show({type: 'success', message: `Сделка №${deal.display_id} восстановлена${stage ? ` в этап «${stage}»` : ''}`, timeout: 3000});
    refresh();
}

function askPurge(deal: Deal) {
    pending.value = deal;
    purgeConfirmation.open({description: `Сделка №${deal.display_id} «${deal.label}» будет удалена навсегда вместе с историей, задачами и файлами. Восстановить её будет нельзя.`});
}

// Confirmation shows the error itself and keeps the dialog open
async function purge() {
    const deal = pending.value;
    if (!deal) return;
    try {
        await runWithId(dealsService.remove(`trash/${deal.id}`).exec(), 'purge' + deal.id);
    } catch (error) {
        throw new Error(errorMessage(error));
    }
    toast.show({type: 'success', message: `Сделка №${deal.display_id} удалена навсегда`, timeout: 3000});
    pending.value = null;
    refresh();
}

async function emptyTrash() {
    let result: any;
    try {
        result = await runWithId(dealsService.remove('trash').exec(), 'empty');
    } catch (error) {
        throw new Error(errorMessage(error));
    }
    toast.show({type: 'success', message: `Удалено навсегда: ${result?.deleted ?? 0}`, timeout: 3000});
    currentPage.value = 1;
    fetchTrash();
}

const searchDebounced = debounce(() => {
    if (currentPage.value !== 1) currentPage.value = 1; // the watcher fetches
    else fetchTrash();
}, 300);

watch(search, searchDebounced);
watch([currentPage, sortBy, perPage], fetchTrash);
onMounted(fetchTrash);
</script>
