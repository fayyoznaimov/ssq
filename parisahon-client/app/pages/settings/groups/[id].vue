<template>
    <div>
        <form @submit.prevent="submit" class="mt-4 px-10">
            <div class="flex flex-col gap-4">
                <h4>Общие данные</h4>
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-6 items-end">
                    <BaseInput
                        type="text"
                        v-model="group.name"
                        label="Название группы*"
                        name="name"
                        placeholder="пр.: Менеджмент"
                        icon="ph:users-three"
                        :loading="isLoading"
                        required
                    />
                </div>
                <p v-if="usage" class="text-sm text-muted-500">
                    Сотрудников в группе: {{ usage.users }}, открытых задач группы: {{ usage.open_tasks }}.
                </p>
            </div>
            <div class="flex justify-end mt-6">
                <div>
                    <BaseButton
                        v-if="group.id"
                        type="button"
                        color="danger"
                        :loading="isLoadingMap.remove"
                        @click="askRemove"
                    >
                        Удалить
                    </BaseButton>
                    <BaseButton
                        class="ml-2"
                        color="primary"
                        :loading="isLoadingMap.save"
                        type="submit"
                    >
                        Сохранить
                    </BaseButton>
                </div>
            </div>
        </form>
        <Modal id="RemoveGroupModal" size="md">
            <template #header>
                <h2 class="text-lg text-muted-900 dark:text-white">Удалить группу</h2>
            </template>
            <div class="flex flex-col gap-4">
                <p class="text-[15px] text-muted-600 dark:text-muted-200">{{ removeText }}</p>
                <BaseSelect
                    v-if="needsTarget && otherGroups.length"
                    v-model="moveTo"
                    label="Перенести сотрудников и открытые задачи в группу*"
                    name="move_to"
                >
                    <option :value="null" disabled>Выберите группу</option>
                    <option
                        v-for="other in otherGroups"
                        :key="other.id"
                        :value="other.id"
                    >
                        {{ other.name }}
                    </option>
                </BaseSelect>
                <p v-if="needsTarget && !otherGroups.length" class="text-sm text-red-500">
                    Других групп нет: сначала создайте группу, в которую перенести сотрудников.
                </p>
            </div>
            <template #footer>
                <div class="flex gap-2">
                    <BaseButton
                        type="button"
                        color="danger"
                        :disabled="needsTarget && !moveTo"
                        :loading="isLoadingMap.remove"
                        @click="remove"
                    >
                        Удалить
                    </BaseButton>
                    <BaseButton type="button" @click="removeModal.close">
                        Отменить
                    </BaseButton>
                </div>
            </template>
        </Modal>
    </div>
</template>

<script lang="ts" setup>
import Modal from '~/components/common/Modal.vue';
import type { Group } from '~/types/user';
import { promiseResult } from '~/utils/result';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Группа',
    subject: 'Group'
});

useHead({
    title: 'Группа'
});

/** GET /groups/:id/usage */
type GroupUsage = { id: number; name: string; users: number; open_tasks: number; tasks: number };

const route = useRoute();
const toast = useToast('GlobalToast');
const groupsService = useService('groups', {auth: true});
const removeModal = useModal('RemoveGroupModal');

const {data: groups, isLoading, run} = useAsync<Group[]>([]);
const { runWithId, isLoadingMap } = useAsync();
const group = ref<Partial<Group>>({});
const usage = ref<GroupUsage | null>(null);
const moveTo = ref<number | null>(null);

const otherGroups = computed(() => (groups.value ?? []).filter((g) => g.id !== group.value.id));
// staff or open tasks: the API deletes such a group only together with moving them (?move_to=)
const needsTarget = computed(() => !!usage.value && (usage.value.users > 0 || usage.value.open_tasks > 0));
const removeText = computed(() => {
    const name = group.value.name ?? '';
    const plans = 'Планы (цели) группы удалятся вместе с ней.';
    if (!usage.value) return `Удалить группу «${name}»? ${plans}`;
    if (!needsTarget.value) return `В группе «${name}» нет сотрудников и открытых задач. ${plans}`;
    return `В группе «${name}» сотрудников: ${usage.value.users}, открытых задач: ${usage.value.open_tasks}. `
        + 'Без группы сотрудники потеряют права «Для группы», а задачи останутся без исполнителя: '
        + `выберите, куда их перенести. ${plans}`;
});

async function loadUsage() {
    if (!group.value.id) return;
    const result = await promiseResult(groupsService.get<GroupUsage>(`${group.value.id}/usage`).exec());
    usage.value = result.ok ? result.value : null;
}

async function askRemove() {
    moveTo.value = null;
    await loadUsage();
    removeModal.open();
}

async function remove() {
    const id = group.value.id!;
    const target = needsTarget.value ? moveTo.value : null;
    const result = await promiseResult(runWithId(groupsService.remove(target ? `${id}?move_to=${target}` : id).exec(), 'remove'));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 4000});
    removeModal.close();
    toast.show({message: 'Группа удалена', type: 'success', timeout: 3000});
    navigateTo('/settings/groups');
}

watchEffect(() => {
    if (route.params.id === 'new') return;
    const found = groups.value.find((g) => g.id === Number(route.params.id));
    if (found) group.value = found;
});

// the counts under the name, so the admin sees who is in the group before deleting it
watch(() => group.value.id, (id) => {
    if (id) loadUsage();
});

async function submit() {
    const {id, ...data} = group.value;
    let promise;
    if (id) promise = groupsService.patch(id, {name: data.name}).exec();
    else promise = groupsService.create({name: data.name}).exec();
    const result = await promiseResult(runWithId(promise, 'save'));
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 3000 });
    navigateTo('/settings/groups');
}

onMounted(() => {
    if (route.params.id !== 'new') run(groupsService.find({limit: 1000}).exec());
});
</script>

<style scoped>

</style>
