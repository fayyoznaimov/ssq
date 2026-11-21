<template>
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
        </div>
        <div class="flex justify-end mt-6">
            <div>
                <BaseButton
                    v-if="group.id"
                    color="danger"
                    :loading="isLoadingMap.remove"
                    @click="remove"
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
</template>

<script lang="ts" setup>
import type { Group } from '~/types/user';


definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Группа',
    subject: 'Group'
});

useHead({
    title: 'Группа'
});

const route = useRoute();
const toast = useToast('GlobalToast');
const groupsService = useService('groups', {auth: true});

const {data: groups, isLoading, run} = useAsync<Group[]>([]);
const { runWithId, isLoadingMap } = useAsync();
const group = ref<Partial<Group>>({});

async function remove() {
    const result = await promiseResult(runWithId(groupsService.remove(group.value.id!).exec(), 'remove'));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    navigateTo('/settings/groups');
}

watchEffect(() => {
    if (route.params.id === 'new') return;
    const found = groups.value.find((g) => g.id === Number(route.params.id));
    if (found) group.value = found;
});

async function submit() {
    const {id, ...data} = group.value;
    let promise;
    if (id) promise = groupsService.patch(id, data).exec();
    else promise = groupsService.create(data).exec();
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
