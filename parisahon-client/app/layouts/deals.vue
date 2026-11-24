<template>
    <TairoCollapseLayout>
        <div class="flex flex-col gap-8">
            <div>
                <h1 class="text-xl">
                    Сделки
                </h1>
                <h2 class="text-sm text-gray-500">
                    Список сделок
                </h2>
            </div>
            <div class="flex flex-wrap gap-5 justify-between">
                <div class="flex items-center gap-4">
                    <PerPageSelect v-model="perPage" />
                    <div class="flex space-x-2 items-center">
                        <NuxtLink to="/deals?view=list" class="text-gray-300 dark:text-white" exact-active-class="text-gray-600">
                            <Icon
                                name="ph:list"
                                size="22"
                                class="text-inherit"
                            />
                        </NuxtLink>
                        <NuxtLink to="/deals?view=kanban" class="text-gray-300 dark:text-white" exact-active-class="text-gray-600">
                            <Icon
                                name="ph:kanban"
                                size="22"
                                class="text-inherit"
                            />
                        </NuxtLink>
                    </div>
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
                <div class="flex items-center gap-4">
                    <BaseButton>
                        ...Еще
                    </BaseButton>
                    <NuxtLink :to="'/settings/deals?from=' + route.href">
                        <BaseButton>
                            Настроить
                        </BaseButton>
                    </NuxtLink>
                    <NuxtLink :to="'/deals/new?from=' + route.href">
                        <BaseButton color="primary">
                            Новая сделка
                        </BaseButton>
                    </NuxtLink>
                </div>
            </div>
            <div>
                <Search
                    v-model="searchQ"
                    :debounce="300"
                    :fields="fields"
                />
            </div>
            <div class="relative overflow-x-auto">
                <NuxtPage :deals="deals" />
            </div>
        </div>
        <Toast id="GlobalToast" />
        <template #toolbar-title>
            {{ pageTitle }}
        </template>
    </TairoCollapseLayout>
</template>

<script lang="ts" setup>
import PerPageSelect from '~/components/common/PerPageSelect.vue';
import Search from '~/components/common/Search.vue';
import Toast from '~/components/common/Toast.vue';
import TairoCollapseLayout from '~/components/tairo/TairoCollapseLayout.vue';

// the header names the page («Сделки», the name of an open company), not the CRM; a page without a title
// of its own gets it in the tab too (its own useHead comes later and wins)
const pageTitle = usePageTitle();
useHead({ title: pageTitle });

const route = useRoute();
const app = useAppConfig();
const perPage = ref(app.pagination.defaultPageSize);

useHead({
    title: 'Сделки'
});

const fields = ref([
    {
        label: 'Название',
        key: 'name'
    },
]);

</script>
