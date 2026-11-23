<template>
    <BaseCard class="flex items-center justify-between p-4 gap-2 overflow-auto">
        <div class="flex items-center gap-2">
            <BaseButton
                :disabled="!props.selected.length"
                class="!px-2 !py-1"
                @click="agentModal.open"
                :loading="isLoadingMap.updatingAgent"
            >
                см. отв.
            </BaseButton>
            <BaseButton
                :disabled="!props.selected.length"
                class="!px-2 !py-1"
                @click="dealTaskModal.open"
            >
                <Icon
                    name="ph:clock"
                    class="me-2 text-blue-600"
                    size="18"
                />
                доб. задачу
            </BaseButton>
            <BaseButton
                :disabled="!props.selected.length"
                class="!px-2 !py-1"
                @click="stageModal.open"
                :loading="isLoadingMap.updatingStage"
            >
                <Icon
                    name="ph:pen"
                    class="me-2 text-yellow-600"
                    size="18"
                />
                изм. этап
            </BaseButton>
            <Can I="delete" a="Deal">
                <BaseButton
                    :disabled="!props.selected.length"
                    :loading="isLoadingMap.removing"
                    class="!px-2 !py-1"
                    title="Переместить в корзину"
                    @click="removeDeals"
                >
                    <Icon
                        name="ph:trash"
                        class="me-2 text-red-600"
                        size="18"
                    />
                    удалить
                </BaseButton>
            </Can>
        </div>
        <p class="text-sm text-center text-gray-400">
            Выбрано {{ props.selected.length }} на:
            <Money :value="props.totalAmount" />
        </p>
    </BaseCard>
    <StageModal
        id="StageModal"
        @saved="changeStage"
    />
    <TaskModal id="TaskModal" />
    <AgentModal id="AgentModal" @saved="changeAgent" />
    <DealTaskModal id="DealTaskModal" @saved="createTasks" />
</template>

<script setup lang="ts">
import { Can } from '@casl/vue';

import Money from '~/components/common/Money.vue';
import AgentModal from '~/components/modals/AgentModal.vue';
import DealTaskModal from '~/components/modals/DealTaskModal.vue';
import StageModal from '~/components/modals/StageModal.vue';
import TaskModal from '~/components/task/TaskModal.vue';
import {useAsync} from '~/composables/useAsync';
import type { Deal, Stage, Task } from '~/types/deal';
import type { User } from '~/types/user';
import {promiseResult} from '~/utils/result';

const props = withDefaults(defineProps<{selected: Deal[], totalAmount: number}>(), {selected: () => [], totalAmount: 0});
const emit = defineEmits(['update']);

const toast = useToast('GlobalToast');
const stageModal = useModal('StageModal');
const agentModal = useModal('AgentModal');
const dealTaskModal = useModal('DealTaskModal');
const { runWithId, isLoadingMap } = useAsync();
const dealsService = useService('deals', {auth: true});
const taskService = useService('tasks', {auth: true});

// DELETE /deals/:id moves a deal to the trash (/deals/trash), where it can be restored
async function removeDeals() {
    const deals = [...(props.selected ?? [])];
    const results = await runWithId(Promise.allSettled(deals.map((deal) => dealsService.remove(deal.id).exec())), 'removing') as PromiseSettledResult<unknown>[];
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    const moved = results.length - failed.length;
    if (moved) toast.show({type: 'success', message: `В корзину: ${moved}`, timeout: 3000});
    if (failed.length) {
        const reason = failed[0].reason;
        const message = reason?.data?.message || reason?.message || 'ошибка';
        toast.show({type: 'error', message: `Не удалено: ${failed.length} (${message})`, timeout: 4000});
    }
    emit('update');
}

async function changeStage(stage: Stage) {
    let promises = props.selected?.map((deal) => dealsService.patch(`${deal.id}/stage`, {stage_id: stage.id}).exec());
    let result = await promiseResult(runWithId(Promise.all(promises), 'updatingStage'));
    if (!result.ok) return toast.show({type: 'error', message: result.error.message, timeout: 3000});
    else emit('update');
}

async function changeAgent(agent: User) {
    let promises = props.selected?.map((deal) => dealsService.patch(deal.id, {
        agent_id: agent.id,
    }).exec());
    let result = await promiseResult(runWithId(Promise.all(promises), 'updatingAgent'));
    if (!result.ok) return toast.show({type: 'error', message: result.error.message, timeout: 3000});
    else emit('update');
}

async function createTasks(task: Task) {
    let promises = props.selected?.map((deal) => taskService.create({
        label: task.label,
        type_id: task.type?.id,
        link_to: {
            target: 'deal',
            id: deal.id,
        },
        assign_to: {
            target: task.agent?.id ? 'agent' : 'group',
            id: task.agent?.id ? task.agent?.id : task.group?.id,
        },
        start_time: task.start_time,
        end_time: task.end_time,
        allDay: task.allDay
    }).exec());
    let result = await promiseResult(runWithId(Promise.all(promises), 'creatingTasks'));
    if (!result.ok) return toast.show({type: 'error', message: result.error.message, timeout: 3000});
}

</script>

<style scoped>

</style>
