<template>
    <div class="flex flex-col gap-8 mt-4 lg:px-10">
        <form @submit.prevent="submit" class="flex flex-col gap-4">
            <h4>Общие данные</h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 items-end">
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
            <div class="flex flex-wrap justify-end gap-2">
                <BaseButton
                    v-if="group.id"
                    type="button"
                    color="danger"
                    variant="outline"
                    :loading="isLoadingMap.remove"
                    @click="askRemove"
                >
                    Удалить
                </BaseButton>
                <BaseButton
                    color="primary"
                    :loading="isLoadingMap.save"
                    type="submit"
                >
                    Сохранить
                </BaseButton>
            </div>
        </form>

        <!-- who is in the group: «Группы» in a card opens the records of exactly these people -->
        <section v-if="group.id" class="flex flex-col gap-3">
            <div class="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h4>Участники</h4>
                    <p class="text-sm text-muted-500">
                        Сотрудник с правом «Группы» видит записи всех участников своей группы.
                    </p>
                </div>
                <div class="flex flex-wrap items-end gap-2">
                    <BaseSelect
                        v-model="candidateId"
                        label="Добавить сотрудника"
                        name="candidate"
                        placeholder="Выберите сотрудника"
                        :classes="{wrapper: 'w-full sm:w-72'}"
                    >
                        <option
                            v-for="candidate in candidates"
                            :key="candidate.id"
                            :value="candidate.id"
                        >
                            {{ candidate.username }} — {{ candidate.group?.name ? `сейчас в «${candidate.group.name}»` : 'без группы' }}
                        </option>
                    </BaseSelect>
                    <BaseButton
                        type="button"
                        :disabled="!candidateId"
                        :loading="isLoadingMap.member"
                        @click="addMember"
                    >
                        Добавить
                    </BaseButton>
                </div>
            </div>
            <ul class="rounded-md border border-muted-200 dark:border-muted-700 divide-y divide-muted-200 dark:divide-muted-700">
                <li
                    v-for="member in members"
                    :key="member.id"
                    class="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                >
                    <div class="flex flex-col min-w-0">
                        <NuxtLink
                            :to="{name: 'settings-users-id', params: {id: member.id}}"
                            class="font-medium text-muted-800 dark:text-muted-100 hover:text-primary-500 truncate"
                        >
                            {{ member.username }}
                        </NuxtLink>
                        <span class="text-xs text-muted-500 truncate">
                            {{ ROLE_NAMES[member.role] ?? member.role }}{{ member.email ? ` · ${member.email}` : '' }}
                        </span>
                    </div>
                    <BaseButton
                        size="sm"
                        type="button"
                        @click="askRemoveMember(member)"
                    >
                        Убрать из группы
                    </BaseButton>
                </li>
                <li v-if="!members.length" class="px-4 py-3 text-sm text-muted-500">
                    {{ staffLoaded ? 'В группе пока никого' : 'Загружаем участников…' }}
                </li>
            </ul>
        </section>

        <Confirmation
            id="RemoveMemberConfirmation"
            title="Убрать из группы"
            description=""
            :on-confirm="removeMember"
        />
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
import Confirmation from '~/components/common/Confirmation.vue';
import Modal from '~/components/common/Modal.vue';
import type { Group, User } from '~/types/user';
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

/** GET /groups/:id/usage (also the answer of adding and removing a member) */
type GroupUsage = { id: number; name: string; users: number; open_tasks: number; tasks: number };

const ROLE_NAMES: Record<string, string> = {admin: 'Администратор', manager: 'Менеджер', agent: 'Агент'};

const route = useRoute();
const toast = useToast('GlobalToast');
const groupsService = useService('groups', {auth: true});
const usersService = useService('users', {auth: true});
const removeModal = useModal('RemoveGroupModal');
const removeMemberConfirmation = useModal('RemoveMemberConfirmation');

const {data: groups, isLoading, run} = useAsync<Group[]>([]);
const { runWithId, isLoadingMap } = useAsync();
const group = ref<Partial<Group>>({});
const usage = ref<GroupUsage | null>(null);
const moveTo = ref<number | null>(null);

// every employee with their group (GET /users/staff): the members of this group and who can be added
const staff = ref<User[]>([]);
const staffLoaded = ref(false);
const candidateId = ref<number | ''>('');
let memberToRemove: User | null = null;

const members = computed(() => staff.value.filter((u) => u.group?.id === group.value.id));
const candidates = computed(() => staff.value.filter((u) => u.group?.id !== group.value.id));

const otherGroups = computed(() => (groups.value ?? []).filter((g) => g.id !== group.value.id));
// staff or open tasks: the API deletes such a group only together with moving them (?move_to=)
const needsTarget = computed(() => !!usage.value && (usage.value.users > 0 || usage.value.open_tasks > 0));
const removeText = computed(() => {
    const name = group.value.name ?? '';
    const plans = 'Планы (цели) группы удалятся вместе с ней.';
    if (!usage.value) return `Удалить группу «${name}»? ${plans}`;
    if (!needsTarget.value) return `В группе «${name}» нет сотрудников и открытых задач. ${plans}`;
    return `В группе «${name}» сотрудников: ${usage.value.users}, открытых задач: ${usage.value.open_tasks}. `
        + 'Без группы сотрудники потеряют права «Группы», а задачи останутся без исполнителя: '
        + `выберите, куда их перенести. ${plans}`;
});

// useService() puts the human Russian text into `message` (the server's own Russian text, or one by the status)
function errorText(e: any): string {
    const message = e?.message || e?.data?.message || 'Не получилось, попробуйте ещё раз';
    return Array.isArray(message) ? message.join('; ') : String(message);
}

async function loadUsage() {
    if (!group.value.id) return;
    const result = await promiseResult(groupsService.get<GroupUsage>(`${group.value.id}/usage`).exec());
    usage.value = result.ok ? result.value : null;
}

async function loadStaff() {
    const result = await promiseResult(usersService.get<{ data: User[] }>('staff').exec());
    if (result.ok) staff.value = result.value?.data ?? [];
    staffLoaded.value = true;
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
    if (!result.ok) return toast.show({message: errorText(result.error), type: 'error', timeout: 4000});
    removeModal.close();
    toast.show({message: 'Группа удалена', type: 'success', timeout: 3000});
    navigateTo('/settings/groups');
}

// POST /groups/:id/members/:user_id: the employee moves here (from another group or none)
async function addMember() {
    const id = Number(candidateId.value);
    const candidate = staff.value.find((u) => u.id === id);
    if (!group.value.id || !candidate) return;
    const result = await promiseResult(runWithId(
        groupsService.post<GroupUsage>(`${group.value.id}/members/${id}`, {}).exec(), 'member'));
    if (!result.ok) return toast.show({message: errorText(result.error), type: 'error', timeout: 4000});
    usage.value = result.value as GroupUsage;
    candidateId.value = '';
    toast.show({message: `${candidate.username} теперь в группе «${group.value.name}»`, type: 'success', timeout: 3000});
    await loadStaff();
}

function askRemoveMember(member: User) {
    memberToRemove = member;
    removeMemberConfirmation.open({
        description: `«${member.username}» останется без группы: право «Группы» будет открывать ему только его `
            + 'собственные записи. Новую группу можно выбрать в карточке сотрудника.',
    });
}

// DELETE /groups/:id/members/:user_id: the employee stays without a group
async function removeMember() {
    const member = memberToRemove;
    if (!group.value.id || !member) return;
    try {
        usage.value = await groupsService.remove<GroupUsage>(`${group.value.id}/members/${member.id}`).exec();
    } catch (e: any) {
        throw new Error(errorText(e));
    }
    toast.show({message: `${member.username} больше не в группе «${group.value.name}»`, type: 'success', timeout: 3000});
    await loadStaff();
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
    if (!result.ok) return toast.show({ message: errorText(result.error), type: 'error', timeout: 3000 });
    navigateTo('/settings/groups');
}

onMounted(() => {
    if (route.params.id !== 'new') {
        run(groupsService.find({limit: 1000}).exec());
        loadStaff();
    }
});
</script>

<style scoped>

</style>
