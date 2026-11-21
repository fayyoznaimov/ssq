<template>
    <BaseCard rounded="sm" class="p-3 hover hover:bg-muted-50 dark:hover:bg-muted-700 transition-colors duration-300 cursor-move card-deal">
        <div class="flex items-start justify-between gap-2">
            <NuxtLink :href="'/deals/' + item.id" class="block min-w-0 flex-1 text-sm leading-tight cursor-pointer break-words">
                <!-- a deal named after its client: the name, phone and company in their own colors -->
                <ClientParts v-if="clientLabel" :deal="item" />
                <template v-else>
                    <span class="text-primary-400 dark:text-primary-300">{{ item.label }}</span>
                    <ClientParts :deal="item" class="mt-0.5 block text-xs" />
                </template>
            </NuxtLink>
            <span class="shrink-0 text-muted-600 text-xs dark:text-muted-400">{{ moment(item?.created_at).format('DD.MM.YY') }}</span>
        </div>
        <div class="mt-1.5 flex items-center justify-between gap-2">
            <Money
                :value="item.budget"
                class="shrink-0 text-sm text-muted-900 dark:text-muted-300"
            />
            <span class="min-w-0 truncate text-xs text-muted-500 dark:text-muted-400" :title="item.agent ? 'Ответственный' : ''">
                {{ item.agent?.username || 'Ответственный не выбран' }}
            </span>
        </div>
    </BaseCard>
</template>

<script setup lang="ts">
import moment from 'moment';

import Money from '~/components/common/Money.vue';
import ClientParts, { isClientLabel } from '~/components/deal/ClientParts.vue';

const props = defineProps<{item: Record<string, any>}>();
const clientLabel = computed(() => isClientLabel(props.item));
</script>
