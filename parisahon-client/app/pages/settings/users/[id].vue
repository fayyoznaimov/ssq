<template>
    <div>
        <form @submit.prevent="submit" class="mt-4 lg:px-10">
            <div class="flex flex-col gap-4">
                <h4>Общие данные</h4>
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-6 items-end">
                    <BaseInput
                        :error="errors.username"
                        type="text"
                        v-model="user.username"
                        label="Имя*"
                        name="username"
                        placeholder="пр.: Shoxrux"
                        icon="ph:user"
                    />
                    <!-- autocomplete off: the browser must not fill in the admin's own login and password here -->
                    <BaseInput
                        v-model="user.email"
                        label="Почта (логин)*"
                        name="email"
                        placeholder="пр.: shoxrux@gmail.com"
                        :error="errors.email"
                        type="text"
                        icon="ph:envelope-simple"
                        autocomplete="off"
                    />

                    <BaseInput
                        type="text"
                        v-model="user.phone"
                        label="Номер телефона"
                        name="phone"
                        placeholder="пр.: +998901200000"
                        icon="ph:phone"
                        :error="errors.phone"
                    />
                    <!-- staff roles only: a customer contact is made in Списки → Контакты -->
                    <BaseSelect :error="errors.role" v-model="user.role" label="Роль*" name="role">
                        <option value="admin">
                            Администратор
                        </option>
                        <option value="manager">
                            Менеджер
                        </option>
                        <option value="agent">
                            Агент
                        </option>
                    </BaseSelect>
                    <BaseSelect
                        :error="errors.group_id"
                        v-model="user.group_id"
                        label="Группа*"
                        name="group_id"
                        placeholder="Выберите группу"
                    >
                        <option
                            v-for="group in groups"
                            :value="group.id"
                            :key="group.id"
                        >
                            {{ group.name }}
                        </option>
                    </BaseSelect>
                    <PasswordInput
                        v-model="user.password"
                        :error="errors.password"
                        :label="user.id ? 'Новый пароль' : 'Пароль*'"
                        :placeholder="user.id ? 'Пусто: пароль не меняется' : 'Не меньше 10 символов'"
                        name="password"
                        autocomplete="new-password"
                    />
                </div>
                <p v-if="user.id && user.password" class="text-sm text-muted-500 -mt-4">
                    <template v-if="isSelf">
                        Новый пароль завершит все ваши сеансы, этот тоже: войдите заново с новым паролем.
                        Telegram-бот CRM отключится. Сменить пароль, не выходя, можно в профиле.
                    </template>
                    <template v-else>
                        Новый пароль завершит все сеансы сотрудника, а его Telegram-бот CRM отключится.
                    </template>
                </p>
                <div class="flex flex-col gap-3">
                    <h4>Права доступа</h4>
                    <!-- the role decides: admin and manager see and change everything (src/auth/access.ts) -->
                    <BaseMessage v-if="user.role === 'admin'" type="info" :closable="false">
                        Администратор — полный доступ: все сделки, компании, контакты и задачи, почта, файлы,
                        аналитика и настройки CRM.
                    </BaseMessage>
                    <BaseMessage v-else-if="user.role === 'manager'" type="info" :closable="false">
                        Менеджер видит и меняет все сделки, компании, контакты и задачи, ему открыты почта, файлы
                        и аналитика; настройки CRM — только у администратора. Таблица прав действует только для
                        роли «Агент».
                    </BaseMessage>
                    <template v-else-if="loaded">
                        <Permissions v-model:permissions="user.permissions" />
                        <div class="flex flex-col gap-3">
                            <BaseCheckbox
                                v-model="user.mail"
                                label="Доступ к почте"
                                name="mailActive"
                            />
                            <BaseCheckbox
                                v-model="user.file"
                                label="Раздел «Файлы» (список файлов; вкладка «Файлы» сделки — по правам на сделку)"
                                name="fileActive"
                            />
                        </div>
                        <BaseMessage v-if="warning" type="warning" :closable="false">
                            {{ warningText }}
                        </BaseMessage>
                    </template>
                </div>
            </div>
            <div class="flex justify-end mt-6">
                <div class="flex flex-wrap justify-end gap-2">
                    <BaseButton
                        v-if="user.id && !isSelf"
                        type="button"
                        :loading="isSignOutPending"
                        @click="signOutConfirmation.open()"
                    >
                        Завершить все сеансы
                    </BaseButton>
                    <BaseButton
                        v-if="user.id && !isSelf"
                        type="button"
                        color="danger"
                        variant="outline"
                        :loading="isDeletePending"
                        @click="askRemove"
                    >
                        Удалить
                    </BaseButton>
                    <BaseButton
                        type="submit"
                        color="primary"
                        :loading="isSavePending"
                    >
                        Сохранить
                    </BaseButton>
                </div>
            </div>
        </form>
        <!-- who changed this account (role, rights, group, password — the fact only), its logins and the bot;
             «Действия сотрудника»: what the employee did in the CRM (the journal of changes, components/audit) -->
        <section v-if="user.id" class="mt-10 lg:px-10">
            <h4 class="mb-3">История изменений</h4>
            <CardHistory scope="user" :id="user.id" staff />
        </section>
        <Confirmation
            id="SignOutUserConfirmation"
            title="Завершить все сеансы"
            description="Сотрудник выйдет из CRM на всех устройствах, его Telegram-бот CRM отключится. Пароль не меняется: войти снова можно с ним же."
            :on-confirm="signOutEverywhere"
        />
        <Confirmation
            id="SaveWithoutRightsConfirmation"
            title="Сохранить без прав на просмотр?"
            description="Сотрудник ничего не увидит."
            :on-confirm="saveAnyway"
        />
        <Modal id="DeleteUserModal" size="md">
            <template #header>
                <h2 class="text-lg text-muted-900 dark:text-white">Удалить сотрудника</h2>
            </template>
            <div class="flex flex-col gap-4">
                <p class="text-[15px] text-muted-600 dark:text-muted-200">
                    Сотрудник «{{ user.username }}» больше не сможет войти в CRM: его сеансы завершатся,
                    Telegram-бот CRM отключится.
                </p>
                <!-- DELETE /users/:id?successor_id=: the colleague takes over the open deals and tasks -->
                <BaseSelect
                    v-model="successorId"
                    label="Открытые сделки и задачи передать"
                    name="successor_id"
                >
                    <option :value="null">Никому: останутся за удалённым сотрудником</option>
                    <option
                        v-for="colleague in colleagues"
                        :key="colleague.id"
                        :value="colleague.id"
                    >
                        {{ colleague.username }}
                    </option>
                </BaseSelect>
            </div>
            <template #footer>
                <div class="flex gap-2">
                    <BaseButton
                        type="button"
                        color="danger"
                        :loading="isDeletePending"
                        @click="remove"
                    >
                        Удалить
                    </BaseButton>
                    <BaseButton type="button" @click="deleteModal.close">
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
import PasswordInput from '~/components/common/PasswordInput.vue';
import Permissions from '~/components/common/Permissions.vue';
import CardHistory from '~/components/audit/CardHistory.vue';
import type { User } from '~/types/user';
import { STANDARD_PERMISSIONS, blindSpot } from '~/utils/casl';
import { promiseResult } from '~/utils/result';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Пользователь',
    subject: 'User',
});

useHead({
    title: 'Пользователь'
});

const route = useRoute();
const toast = useToast('GlobalToast');
const usersService = useService('users', {auth: true});
const groupsService = useService('groups', {auth: true});
const authService = useService('auth', {auth: true});
const signOutConfirmation = useModal('SignOutUserConfirmation');
const saveConfirmation = useModal('SaveWithoutRightsConfirmation');
const deleteModal = useModal('DeleteUserModal');
const me = useState<User>('user');

const user = ref<any>({});

const errors = ref<Record<string, string>>({});
const isDeletePending = ref(false);
const isSavePending = ref(false);
const isSignOutPending = ref(false);
const groups = ref<{ id: number; name: string }[]>([]);
const loaded = ref(false);

// One's own account: signed out and deleted from the profile / not at all
const isSelf = computed(() => !!user.value.id && user.value.id === me.value?.id);

// What the API applies to a level that is not stored (src/auth/access.ts): the agent's own deals,
// every company, contact and task. The card shows these, saving stores them.
const missingLevels = {
    deal: {create: 3, view: 1, update: 1, delete: 1, export: 0},
    contact: {create: 3, view: 3, update: 3, delete: 3, export: 0},
    company: {create: 3, view: 3, update: 3, delete: 3, export: 0},
    task: {update: 3, delete: 3},
};

/** The stored rights with every level filled in; "create" is either 0 or 3 (any level above 0 allows it). */
function withMissingLevels(stored: any) {
    const result: Record<string, Record<string, number>> = {};
    for (const [entity, levels] of Object.entries(missingLevels)) {
        result[entity] = {...levels};
        for (const action of Object.keys(levels)) {
            const value = stored?.[entity]?.[action];
            if (typeof value === 'number') result[entity][action] = action === 'create' ? (value > 0 ? 3 : 0) : value;
        }
    }
    return result;
}

onMounted(async () => {
    const found = await promiseResult(groupsService.find().exec());
    groups.value = found.ok && Array.isArray(found.value) ? found.value : [];
    if (route.params.id === 'new') {
        // a new employee starts with the standard rights: their own deals, companies, contacts and tasks
        user.value = {
            role: 'agent',
            group_id: '',
            permissions: JSON.parse(JSON.stringify(STANDARD_PERMISSIONS)),
            mail: true,
            file: true,
        };
    } else {
        const loadedUser = await promiseResult(usersService.get(route.params.id as string).exec());
        if (!loadedUser.ok) {
            toast.show({message: errorText(loadedUser.error), timeout: 4000, type: 'error'});
            return navigateTo('/settings/users', {replace: true});
        }
        // a customer contact is not an employee: its card is in Списки → Контакты
        if (loadedUser.value?.role === 'ctr_agent') {
            return navigateTo(`/lists/contacts/${loadedUser.value.id}`, {replace: true});
        }
        user.value = loadedUser.value;
        // null for an account made without rights (the first admin from the server settings)
        const stored = user.value.permissions ?? null;
        user.value.permissions = withMissingLevels(stored);
        // a switch that is not stored counts as on, as the API reads it
        user.value.mail = stored?.mail !== false;
        user.value.file = stored?.file !== false;
        // "": no group yet (the placeholder of the select)
        user.value.group_id = user.value.group?.id ?? '';
        user.value.company_id = user.value.company?.id;
    }
    loaded.value = true;
});

/** An agent whose levels hide everything, or even their own deals (utils/casl.ts blindSpot): warned before saving. */
const warning = computed(() => (loaded.value
    ? blindSpot({role: user.value.role, permissions: {...user.value.permissions, mail: user.value.mail, file: user.value.file}})
    : null));
const warningText = computed(() => (warning.value === 'nothing'
    ? 'Нет прав на просмотр: сотрудник ничего не увидит — ни сделок, ни компаний, ни контактов. Нажмите «Стандартные: свои записи» или откройте нужное.'
    : 'Просмотр сделок — «Нет»: сотрудник не увидит даже свои сделки, в том числе те, что ему передали коллеги.'));

// useService() puts the human Russian text into `message` (the server's own Russian text, or one by the status)
function errorText(e: any): string {
    const message = e?.message || e?.data?.message || 'Не получилось, попробуйте ещё раз';
    return Array.isArray(message) ? message.join('; ') : String(message);
}

// The colleague who takes over the open deals and tasks of a removed employee (none: they stay with them)
const successorId = ref<number | null>(null);
const colleagues = ref<{ id: number; username: string }[]>([]);

async function askRemove() {
    successorId.value = null;
    // GET /users/staff: the employees, by name (an API without it: the list stays empty)
    const result = await promiseResult(usersService.get<{ data: { id: number; username: string }[] }>('staff').exec());
    colleagues.value = result.ok ? (result.value?.data ?? []).filter((u) => u.id !== user.value.id) : [];
    deleteModal.open();
}

async function remove() {
    const successor = successorId.value;
    isDeletePending.value = true;
    let moved: { deals?: number; tasks?: number } | null = null;
    try {
        moved = await usersService.remove<{ deals?: number; tasks?: number }>(
            successor ? `${user.value.id}?successor_id=${successor}` : user.value.id,
        ).exec();
    } catch (e: any) {
        toast.show({message: errorText(e), timeout: 4000, type: 'error'});
        return;
    } finally {
        isDeletePending.value = false;
    }
    deleteModal.close();
    const message = successor
        ? `Сотрудник удалён. Передано сделок: ${moved?.deals ?? 0}, задач: ${moved?.tasks ?? 0}`
        : 'Сотрудник удалён';
    toast.show({message, timeout: 4000, type: 'success'});
    navigateTo('/settings/users');
}

// POST /auth/logout/:id: every token of the account stops working, the CRM bot is unlinked
async function signOutEverywhere() {
    isSignOutPending.value = true;
    try {
        await authService.post(`logout/${user.value.id}`, {}).exec();
    } catch (e: any) {
        throw new Error(errorText(e));
    } finally {
        isSignOutPending.value = false;
    }
    toast.show({message: 'Все сеансы сотрудника завершены, Telegram-бот CRM отключён', timeout: 4000, type: 'success'});
}

/** POST / PATCH /users; throws the API's error. */
async function save() {
    const {id, ...data} = user.value;
    data.permissions = {...(data.permissions ?? withMissingLevels(null)), mail: Boolean(data.mail), file: Boolean(data.file)};
    delete data.mail;
    delete data.file;
    // empty: the password stays as it is
    if (!data.password) delete data.password;
    isSavePending.value = true;
    try {
        if (id) {
            await usersService.patch(id, data).exec();
        } else {
            await usersService.create(data).exec();
        }
    } finally {
        isSavePending.value = false;
    }
    navigateTo('/settings/users');
}

async function submit() {
    errors.value = {};
    if (!user.value.group_id) {
        errors.value.group_id = 'Выберите группу';
        return;
    }
    // an agent who would see nothing: the admin confirms it first (ACL-15)
    if (warning.value) {
        saveConfirmation.open({
            description: warning.value === 'nothing'
                ? 'Сотрудник ничего не увидит: ни сделок, ни компаний, ни контактов.'
                : 'Сотрудник не увидит даже свои сделки, в том числе те, что ему передали коллеги.',
        });
        return;
    }
    try {
        await save();
    } catch (e: any) {
        toast.show({message: errorText(e), timeout: 4000, type: 'error'});
    }
}

// «Подтвердить» of the warning: an error is shown by the confirmation window
async function saveAnyway() {
    try {
        await save();
    } catch (e: any) {
        throw new Error(errorText(e));
    }
}
</script>
