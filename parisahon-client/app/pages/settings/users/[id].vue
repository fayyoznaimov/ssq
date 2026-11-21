<template>
    <form @submit.prevent="submit" class="mt-4 px-10">
        <div class="flex flex-col gap-4">
            <h4>Общие данные</h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-6 items-end">
                <BaseInput
                    :error="errors.username"
                    type="text"
                    v-model="user.username"
                    label="Логин*"
                    name="username"
                    placeholder="пр.: Shoxrux"
                    icon="ph:user"
                />
                <BaseInput
                    v-model="user.email"
                    label="Почта*"
                    name="email"
                    placeholder="пр.: shoxrux@gmail.com"
                    :error="errors.email"
                    type="text"
                    icon="ph:envelope-simple"
                />

                <BaseInput
                    type="text"
                    v-model="user.phone"
                    label="Номер телефона"
                    name="phone"
                    placeholder="пр.: +998901200000"
                    icon="ph:phone"
                    required
                    :error="errors.phone"
                />
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
                    <option value="ctr_agent">
                        Контр агент
                    </option>
                </BaseSelect>
                <BaseSelect :error="errors.groups" v-model="user.group_id" label="Группа*" name="group_id">
                    <option
                        v-for="group in groups"
                        :value="group.id"
                        :key="group.id"
                    >
                        {{ group.name }}
                    </option>
                    <option v-if="!groups.length">Нет компаний</option>
                </BaseSelect>
                <PasswordInput
                    v-model="user.password"
                    :error="errors.password"
                    label="Пароль*"
                    placeholder="Пароль вашего аккаунта"
                    name="password"
                />
            </div>
            <div>
                <h4></h4>
            </div>
            <div>
                <div class="flex justify-between items-center mb-3">
                    <h4>Права доступа</h4>
                </div>
                <div class="mb-3">
                    <BaseSwitchBall
                        v-model="isAdminAccess"
                        label="Админкие права"
                    />
                </div>
                <Permissions v-if="rerender" v-model:permissions="user.permissions" />
            </div>
            <div class="flex flex-col gap-3">
                <BaseCheckbox
                    v-model="user.mail"
                    label="Доступ к почте"
                    name="mailActive"
                />
                <BaseCheckbox
                    v-model="user.file"
                    label="Доступ к файлам"
                    name="fileActive"
                />
            </div>
        </div>
        <div class="flex justify-end mt-6">
            <div>
                <BaseButton
                    v-if="user.id"
                    color="danger"
                    :loading="isDeletePending"
                    @click="remove"
                >
                    Удалить
                </BaseButton>
                <BaseButton
                    class="ml-2"
                    color="primary"
                    :loading="isSavePending"
                    @click="submit"
                >
                    Сохранить
                </BaseButton>
            </div>
        </div>
    </form>
</template>

<script lang="ts" setup>


import PasswordInput from '~/components/common/PasswordInput.vue';
import Permissions from '~/components/common/Permissions.vue';

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

const user = ref<any>({});

const errors = ref<Record<string, string>>({});
const isDeletePending = ref(false);
const isSavePending = ref(false);
const groups = ref([]);
const rerender = ref(false);

onMounted(async () => {
    groups.value = await groupsService.find().exec();
    if (route.params.id === 'new') {
        user.value = {};
        user.value.permissions = defaultAccess.value;
    } else {
        user.value = await usersService.get(route.params.id as string).exec();
        const { mail, file, ...permissions } = user.value.permissions;
        defaultAccess.value = permissions;
        user.value.mail = Boolean(mail);
        user.value.file = Boolean(file);
        user.value.group_id = user.value.group?.id;
        user.value.company_id = user.value.company?.id;
    }
    rerender.value = true;
});

const isAdminAccess = ref(false);

watch(isAdminAccess, (value) => {
    if (value) {
        user.value.permissions = adminAccess.value;
        user.value.mail = true;
        user.value.file = true;
        user.value.role = 'admin';
    } else {
        user.value.permissions = defaultAccess.value;
        user.value.mail = false;
        user.value.file = false;
        user.value.role = '';
    }
});

async function remove() {
    isDeletePending.value = true;
    try {
        await usersService.remove(user.value.id);
        toast.show({message: 'Успешно удалено', timeout: 3000, type: 'success'});
        navigateTo('/settings/users');
    } catch (e: any) {
        toast.show({message: e.message, timeout: 3000, type: 'error'});
    } finally {
        isDeletePending.value = false;
    }
}

async function submit() {
    const {id, ...data} = user.value;
    errors.value = {};
    isSavePending.value = true;
    if (!data.permissions) data.permissions = {};
    data.permissions.mail = Boolean(data.mail);
    data.permissions.file = Boolean(data.file);
    try {
        if (id) {
            await usersService.patch(id, data).exec();
        } else {
            await usersService.create(data).exec();
        }
        navigateTo('/settings/users');
    } catch (e: any) {
        if (e.code === 400 || e.code === 422) {
            for (const err of e.errors) {
                errors.value[err.path] = useText(`errors.${err.type}`);
            }
        } else {
            toast.show({message: e.message, timeout: 3000, type: 'error'});
        }
    } finally {
        isSavePending.value = false;
    }
}

const adminAccess = ref({
    deal: {
        create: 3,
        view: 3,
        update: 3,
        delete: 3,
        export: 3,
    },
    contact: {
        create: 3,
        view: 3,
        update: 3,
        delete: 3,
        export: 3,
    },
    company: {
        create: 3,
        view: 3,
        update: 3,
        delete: 3,
        export: 3,
    },
    task: {
        update: 3,
        delete: 3,
    },
});

const defaultAccess = ref({
    deal: {
        create: 0,
        view: 0,
        update: 0,
        delete: 0,
        export: 0,
    },
    contact: {
        create: 0,
        view: 0,
        update: 0,
        delete: 0,
        export: 0,
    },
    company: {
        create: 0,
        view: 0,
        update: 0,
        delete: 0,
        export: 0,
    },
    task: {
        update: 0,
        delete: 0,
    },
});
</script>

<style scoped>

</style>
