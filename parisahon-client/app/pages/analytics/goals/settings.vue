<template>
    <div class="flex flex-col gap-6 pb-20 sm:pb-0">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
                <h1 class="text-xl">Цели по сделкам</h1>
                <p class="text-sm text-muted-500">
                    План продаж на месяц, квартал и год. Месячная цель сама подставляет квартал (×3) и год (×12), пока их не изменили вручную.
                    Цель группы делится поровну между её участниками; цели участников в сумме дают цель группы.
                </p>
            </div>
            <!-- on a phone the buttons stay at the bottom of the screen -->
            <div class="fixed inset-x-0 bottom-0 z-20 flex justify-end gap-2 border-t border-muted-200 bg-white p-3 dark:border-muted-700 dark:bg-muted-900 sm:static sm:border-0 sm:bg-transparent sm:p-0 sm:dark:bg-transparent">
                <BaseButton to="/analytics/goals">Отменить</BaseButton>
                <BaseButton color="primary" @click="onSave" :disabled="saving">Сохранить</BaseButton>
            </div>
        </div>

        <div class="max-w-4xl">
            <!-- the column heads (wide screens; on a phone every field has its own label) -->
            <div class="hidden sm:grid grid-cols-[240px_repeat(3,minmax(0,1fr))] gap-3 px-3 pb-2 text-xs uppercase font-semibold text-muted-400">
                <span>Группа / сотрудник</span>
                <span>Месяц</span>
                <span>Квартал</span>
                <span>Год</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-[240px_repeat(3,minmax(0,1fr))] gap-3 rounded-md bg-muted-100 dark:bg-muted-800 px-3 py-2 text-sm text-muted-700 dark:text-muted-200">
                <span class="font-semibold">Всего</span>
                <span><span class="sm:hidden text-muted-400">Месяц: </span><b>{{ formatSum(totals.monthly) }}</b></span>
                <span><span class="sm:hidden text-muted-400">Квартал: </span><b>{{ formatSum(totals.quarterly) }}</b></span>
                <span><span class="sm:hidden text-muted-400">Год: </span><b>{{ formatSum(totals.yearly) }}</b></span>
            </div>

            <ul class="flex flex-col gap-6 mt-6">
                <li v-for="(objective, oidx) in objectives" :key="objective.id" class="flex flex-col gap-1">
                    <div class="grid grid-cols-1 sm:grid-cols-[240px_repeat(3,minmax(0,1fr))] gap-2 sm:gap-3 items-center px-3 py-2 rounded-md bg-primary-50/60 dark:bg-primary-900/20">
                        <div class="min-w-0">
                            <span class="font-semibold text-muted-800 dark:text-white break-words">{{ objective.name }}</span>
                            <p class="text-xs text-muted-500">
                                {{ objective.users.length ? `делится поровну между участниками (${objective.users.length})` : 'в группе нет сотрудников' }}
                            </p>
                        </div>
                        <MoneyInput v-for="key in KEYS" :key="key" v-model="objective.objectives[key]" :label="phone ? LABELS[key] : undefined"
                            @update:model-value="() => onGroupGoalChange(key, oidx)" :classes="{wrapper: 'w-full min-w-0'}" />
                    </div>
                    <ul v-if="objective.users.length" class="flex flex-col">
                        <li v-for="(user, uidx) in objective.users" :key="user.id"
                            class="grid grid-cols-1 sm:grid-cols-[240px_repeat(3,minmax(0,1fr))] gap-2 sm:gap-3 items-center px-3 py-2"
                            :class="uidx % 2 ? 'bg-muted-50 dark:bg-muted-900/40' : ''">
                            <span class="text-muted-700 dark:text-muted-200 break-words sm:ps-3">{{ user.username }}</span>
                            <MoneyInput v-for="key in KEYS" :key="key" v-model="user.objectives[key]" :label="phone ? LABELS[key] : undefined"
                                @update:model-value="() => onUserGoalChange(key, oidx, uidx)" :classes="{wrapper: 'w-full min-w-0'}" />
                        </li>
                    </ul>
                </li>
            </ul>
        </div>
    </div>
</template>

<script lang="ts" setup>
import type { ObjectiveStat } from '~/types/stats';
import MoneyInput from '~/components/common/MoneyInput.vue';
import { formatSum } from '~/utils/format';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Настройки целей'
});

useHead({
    title: 'Настройки целей'
});

type Key = 'monthly' | 'quarterly' | 'yearly';
const KEYS: Key[] = ['monthly', 'quarterly', 'yearly'];
const LABELS: Record<Key, string> = { monthly: 'Месяц', quarterly: 'Квартал', yearly: 'Год' };
// a monthly plan fills the quarter and the year until they are changed by hand
const FROM_MONTH: Partial<Record<Key, number>> = { quarterly: 3, yearly: 12 };

const toast = useToast('GlobalToast');
const objectivesService = useService('analytics/objectives', {auth: true});
const {data: objectives, run: runObjectives} = useAsync<ObjectiveStat[]>([])
const {runAsync: saveAsync, isLoading: saving} = useAsync();

// field labels on a phone (the column heads are hidden there)
const phone = ref(false);
onMounted(() => {
    const query = window.matchMedia('(max-width: 639px)');
    phone.value = query.matches;
    query.addEventListener?.('change', (e) => (phone.value = e.matches));
});

// the quarter / year fields the admin typed into: they are not filled from the month any more
const typedByHand = reactive(new Set<string>());

const totals = computed(() => {
    let monthly = 0;
    let quarterly = 0;
    let yearly = 0;
    for (const objective of objectives.value) {
        monthly += Number(objective.objectives.monthly) || 0;
        quarterly += Number(objective.objectives.quarterly) || 0;
        yearly += Number(objective.objectives.yearly) || 0;
    }

    return {monthly, quarterly, yearly}
});

/** the group's plan is the sum of its people's plans */
function sumUsers(oidx: number, key: Key) {
    const objective = objectives.value[oidx];
    if (!objective.users.length) return;
    objective.objectives[key] = objective.users.reduce((total, user) => total + (Number(user.objectives[key]) || 0), 0);
}

/** the group's plan split evenly between its people (the remainder to the first) */
function splitGroup(oidx: number, key: Key) {
    const objective = objectives.value[oidx];
    const count = objective.users.length;
    if (!count) return; // a group without people (it used to fail on users[0])
    const total = Number(objective.objectives[key]) || 0;
    const part = Math.floor(total / count);
    const remainder = total - part * count;
    objective.users.forEach((user, index) => {
        user.objectives[key] = part + (index === 0 ? remainder : 0);
    });
}

/** a new monthly plan: the quarter and the year follow unless typed by hand */
function followMonth(target: { objectives: Record<Key, number> }, owner: string) {
    for (const key of ['quarterly', 'yearly'] as Key[]) {
        if (!typedByHand.has(`${owner}:${key}`)) target.objectives[key] = (Number(target.objectives.monthly) || 0) * (FROM_MONTH[key] ?? 1);
    }
}

function onUserGoalChange(key: Key, oidx: number, uidx: number) {
    const objective = objectives.value[oidx];
    const user = objective.users[uidx];
    if (key === 'monthly') {
        followMonth(user as any, `u${user.id}`);
        for (const k of KEYS) sumUsers(oidx, k);
    } else {
        typedByHand.add(`u${user.id}:${key}`);
        sumUsers(oidx, key);
    }
}

function onGroupGoalChange(key: Key, oidx: number) {
    const objective = objectives.value[oidx];
    if (key === 'monthly') {
        followMonth(objective as any, `g${objective.id}`);
        for (const k of KEYS) splitGroup(oidx, k);
    } else {
        typedByHand.add(`g${objective.id}:${key}`);
        splitGroup(oidx, key);
    }
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
