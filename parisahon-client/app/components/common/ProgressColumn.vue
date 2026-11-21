<template>
    <div class="space-y-5">
        <div>
            <div class="flex flex-col items-center justify-center pt-2 pb-1.5">
                <h2 class="uppercase text-xs font-semibold">{{ props.stageName }}</h2>
                <span class="text-sm text-muted-700 dark:text-muted-400">
                    {{ arr?.length || 0 }} сделок: 
                    <Money :value="stageDealsBudget" />
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
import { useAsync } from '~/composables/useAsync';
import {useService} from '~/composables/useService';
import type { Deal } from '~/types/deal';
import type { Stage } from '~/types/stage';
import { promiseResult } from '~/utils/result';

const { runAsync: patchAsync } = useAsync();
const props = withDefaults(defineProps<{ columnData: [], isCreateDeal: boolean, stage: any, stageName: string}>(),
    {
        columnData: () => ([]),
    });

const dragging = defineModel('dragging');
const emits = defineEmits<{
    (e: 'stage:changed', {id, stage}: {id: number, stage: Stage}): void;
    (e: 'stage:patched', {id, stage}: {id: number, stage: Stage}): void;
    (e: 'deal:created', value: Deal): void;
}>();

const arr = computed(() => props.columnData);
const toast = useToast('GlobalToast');
const dealsService = useService('deals', { auth: true });

async function changeStage(event: Record<string, any>) {
    if (event.added) {
        const id = event.added.element.id;
        emits('stage:changed', { id, stage: props.stage });
        const result = await promiseResult(patchAsync(dealsService.patch(`${id}/stage`, { stage_id: props.stage.id }).exec()));
        if (!result.ok) return toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        emits('stage:patched', { id, stage: props.stage });
    }
}

const stageDealsBudget = computed(() => {
    return arr.value?.reduce((acc, deal) => acc + +deal.budget, 0);
});

</script>

<style scoped>
.ghost {
    opacity: 0.5;
}
</style>
