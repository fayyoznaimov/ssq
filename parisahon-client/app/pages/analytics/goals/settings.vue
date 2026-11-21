<template>
    <div class="flex flex-col gap-8">
        <div class="flex justify-between">
            <h1 class="text-xl">Цели по сделкам</h1>
            <div>
                <BaseButton to="/analytics/goals">Отменить</BaseButton>
                <BaseButton color="primary" class="ml-2" @click="onSave" :disabled="saving">Сохранить</BaseButton>
            </div>
        </div>
        <div class="text-muted-700 grid grid-cols-12 mt-6 dark:text-muted-200">
            <span class="col-span-7">Всего</span>
            <ul class="col-span-5 flex text-sm">
                <li class="flex flex-col flex-1">
                    <span>Бюджет (месяц)</span>
                    <Money :value="totals.monthly" />
                </li>
                <li class="flex flex-col flex-1">
                    <span>Бюджет (квартал)</span>
                    <Money :value="totals.quarterly" />
                </li>
                <li class="flex flex-col flex-1">
                    <span>Бюджет (год)</span>
                    <Money :value="totals.yearly" />
                </li>
            </ul>
        </div>
        <ul class="flex flex-col gap-8">
            <li v-for="(objective, oidx) in objectives">
                <div class="grid grid-cols-12">
                    <span class="font-semibold text-lg col-span-7">{{ objective.name }}</span>
                    <div class="flex gap-2 col-span-5">
                        <MoneyInput v-model="objective.objectives.monthly" @update:model-value="() => onGroupGoalChange('monthly', oidx)" :classes="{wrapper: 'w-full'}" />
                        <MoneyInput v-model="objective.objectives.quarterly" @update:model-value="() => onGroupGoalChange('quarterly', oidx)" :classes="{wrapper: 'w-full'}"/>
                        <MoneyInput v-model="objective.objectives.yearly" @update:model-value="() => onGroupGoalChange('yearly', oidx)" :classes="{wrapper: 'w-full'}" />
                    </div>
                </div>
                <ul v-if="objective.users.length" class="mt-2 flex flex-col gap-2">
                    <li v-for="(user, useridx) in objective.users" class="grid grid-cols-12">
                        <span class="text-muted-700 col-span-7 dark:text-muted-200">
                            {{ user.username }}
                        </span>
                        <div class="flex gap-2 col-span-5">
                            <MoneyInput v-model="user.objectives.monthly" @update:model-value="() => onUserGoalChange('monthly', oidx)" :classes="{wrapper: 'w-full'}" />
                            <MoneyInput v-model="user.objectives.quarterly" @update:model-value="() => onUserGoalChange('quarterly', oidx)" :classes="{wrapper: 'w-full'}"/>
                            <MoneyInput v-model="user.objectives.yearly" @update:model-value="() => onUserGoalChange('yearly', oidx)" :classes="{wrapper: 'w-full'}"/>
                        </div>
                    </li>
                </ul>
            </li>
        </ul>
    </div>
</template>

<script lang="ts" setup>
import type { ObjectiveStat } from '~/types/stats';
import MoneyInput from '~/components/common/MoneyInput.vue';
import Money from '~/components/common/Money.vue';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Настройки целей'
});

useHead({
    title: 'Настройки целей'
});

const toast = useToast('GlobalToast');
const objectivesService = useService('analytics/objectives', {auth: true});
const {data: objectives, run: runObjectives} = useAsync<ObjectiveStat[]>([])
const {runAsync: saveAsync, isLoading: saving} = useAsync();

const totals = computed(() => {
    let monthly = 0;
    let quarterly = 0;
    let yearly = 0;
    for (const objective of objectives.value) {
        monthly += objective.objectives.monthly;
        quarterly += objective.objectives.quarterly;
        yearly += objective.objectives.yearly;
    }

    return {monthly, quarterly, yearly}
});

function onUserGoalChange(key: 'monthly' | 'quarterly' | 'yearly', oidx: number) {
    const objective = objectives.value[oidx];
    let total = 0;
    for (const user of objective.users) {
        total += user.objectives[key];
    }
    objective.objectives[key] = total;
}

function onGroupGoalChange(key: 'monthly' | 'quarterly' | 'yearly', oidx: number) {
    const objective = objectives.value[oidx];
    const total = objective.objectives[key];
    const part = Math.floor(total / objective.users.length);
    const remainder = total % objective.users.length;
    for (const user of objective.users) {
        user.objectives[key] = part;
    }

    objective.users[0].objectives[key] += remainder;
}

async function onSave() {
    const result = await promiseResult(saveAsync(objectivesService.patch('', {data: objectives.value}).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    navigateTo('/analytics/goals');
}

onMounted(() => {
    runObjectives(objectivesService.find().exec());
});

</script>