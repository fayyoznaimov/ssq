<template>
    <div class="space-y-5">
        <div>
            <div class="flex flex-col items-center justify-center pt-2 pb-1.5">
                <h2 class="uppercase text-xs font-semibold">{{ props.stageName }}</h2>
                <!-- the totals of the whole column (the server counts them), not of the cards loaded -->
                <span class="text-sm text-muted-700 dark:text-muted-400">
                    {{ countOf(count, 'сделка', 'сделки', 'сделок') }}:
                    <Money :value="columnBudget" />
                </span>
                <span v-if="props.closedSince" class="text-xs text-muted-500 dark:text-muted-400">
                    закрытые с {{ formatDay(props.closedSince) }}
                </span>
            </div>
            <hr class="border-2" :style="{borderColor: props.stage.color }">
            <p class="text-muted-700 text-sm mt-1 dark:text-muted-400">{{ props.stage.description }}</p>
        </div>
        <AddDealCard
            v-if="props.isCreateDeal"
            :stage="props.stage"
            @deal:created="emits('deal:created', $event)"
        />
        <Draggable
            v-bind="dragOptions"
            v-model="arr"
            :group="{name: 'cards', pull: true}"
            item-key="id"
            class="space-y-2 min-h-[36rem] max-h-[44rem] overflow-y-auto no-scrollbar"
            @change="changeStage"
            @start="dragging = true"
            @end="dragging = false"
        >
            <template #item="{element}">
                <CardDeal :item="element" />
            </template>
        </Draggable>
        <div v-if="count > arr.length" class="board-more flex flex-col items-center gap-1">
            <span class="text-xs text-muted-600 dark:text-muted-400">Показано {{ arr.length }} из {{ count }}</span>
            <BaseButton size="sm" :loading="props.loadingMore" :disabled="props.loadingMore" @click="emits('load-more')">
                Показать ещё
            </BaseButton>
        </div>
    </div>
</template>

<script setup lang="ts">
const dragOptions = {
    animation: 200,
    ghostClass: 'ghost',
};

import Draggable from 'vuedraggable';

import AddDealCard from '~/components/common/AddDealCard.vue';
import CardDeal from '~/components/common/CardDeal.vue';
import Money from '~/components/common/Money.vue';
import { countOf, formatDay } from '~/utils/format';
import { useAsync } from '~/composables/useAsync';
import {useService} from '~/composables/useService';
import type { Deal } from '~/types/deal';
import type { Stage } from '~/types/stage';
import { promiseResult } from '~/utils/result';
import { askLostReason, isLostStage } from '~/components/history/lostReason';

const { runAsync: patchAsync } = useAsync();
const props = withDefaults(defineProps<{
    columnData: any[],
    isCreateDeal: boolean,
    stage: any,
    stageName: string,
    // the number of deals and their budget in the whole column (GET /deals/board)
    total?: number,
    budget?: number,
    loadingMore?: boolean,
    // a closing column shows the deals closed since then
    closedSince?: string | null,
}>(),
    {
        columnData: () => ([]),
        total: undefined,
        budget: undefined,
        loadingMore: false,
        closedSince: null,
    });

const dragging = defineModel('dragging');
const emits = defineEmits<{
    (e: 'stage:changed', {id, stage}: {id: number, stage: Stage}): void;
    (e: 'stage:patched', {id, stage}: {id: number, stage: Stage}): void;
    (e: 'deal:created', value: Deal): void;
    (e: 'load-more'): void;
}>();

const arr = computed(() => props.columnData);
const toast = useToast('GlobalToast');
const dealsService = useService('deals', { auth: true });

async function changeStage(event: Record<string, any>) {
    if (event.added) {
        const id = event.added.element.id;
        // the card still has the stage it came from: it goes back there when the server refuses
        const from = event.added.element.stage as Stage | null;
        emits('stage:changed', { id, stage: props.stage });
        const result = await promiseResult(patchAsync(dealsService.patch(`${id}/stage`, { stage_id: props.stage.id }).exec()));
        if (!result.ok) {
            if (from?.id) emits('stage:changed', { id, stage: from });
            return toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        }
        emits('stage:patched', { id, stage: props.stage });
        // dropped into «Закрыто и не реализовано»: why (DEAL-11), saved by the modal of the board page
        if (isLostStage(props.stage)) {
            const card = event.added.element as Deal;
            askLostReason({ deal: { id, display_id: card.display_id, label: card.label } });
        }
    }
}

const stageDealsBudget = computed(() => {
    return arr.value?.reduce((acc, deal) => acc + +deal.budget, 0);
});

const count = computed(() => props.total ?? arr.value?.length ?? 0);
const columnBudget = computed(() => props.budget ?? stageDealsBudget.value);

</script>

<style scoped>
.ghost {
    opacity: 0.5;
}
</style>
