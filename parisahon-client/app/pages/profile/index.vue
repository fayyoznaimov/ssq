<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Профиль</h1>
            <h2 class="text-sm text-gray-500">Настройки профиля</h2>
        </div>
        <div>
            <form class="flex flex-col gap-4">
                <div class="grid grid-cols-2 gap-4">
                    <BaseInput
                        v-model.trim="user.username"
                        label="Логин"
                        placeholder="Логин"
                        :error="errors.username"
                        icon="ph:user"
                        readonly
                    />
                    <BaseInput
                        v-model="user.email"
                        label="Почта"
                        name="email"
                        placeholder="пр.: shoxrux@gmail.com"
                        :error="errors.email"
                        type="text"
                        icon="ph:envelope-simple"
                        readonly
                    />
                    <BaseSelect :error="errors.role" v-model="user.role" label="Роль" name="role" readonly>
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
                    <BaseSelect v-if="user.group" label="Группа*" name="groupId" v-model="user.group.id" :loading="groupsLoading" readonly>
                        <option
                            v-for="group in groups"
                            :value="group.id"
                            :key="group.id"
                        >
                            {{ group.name }}
                        </option>
                        <option v-if="!groups.length">Нет компаний</option>
                    </BaseSelect>
                </div>
            </form>
        </div>
        <BaseCard class="p-6 flex flex-col gap-3 max-w-2xl">
            <div class="flex items-center gap-2">
                <Icon name="ph:lock-key" class="size-6 text-muted-500" />
                <h3 class="text-lg">Смена пароля</h3>
            </div>
            <form class="grid grid-cols-1 sm:grid-cols-3 gap-4" @submit.prevent="changePassword">
                <BaseInput
                    v-model="password.old"
                    label="Текущий пароль"
                    name="old_password"
                    type="password"
                    autocomplete="current-password"
                    :error="password.errors.old"
                />
                <BaseInput
                    v-model="password.new"
                    label="Новый пароль"
                    name="new_password"
                    type="password"
                    autocomplete="new-password"
                    placeholder="не меньше 8 символов"
                    :error="password.errors.new"
                />
                <BaseInput
                    v-model="password.repeat"
                    label="Ещё раз"
                    name="repeat_password"
                    type="password"
                    autocomplete="new-password"
                    :error="password.errors.repeat"
                />
                <div class="sm:col-span-3 flex items-center gap-3">
                    <BaseButton color="primary" type="submit" :loading="password.busy">Сменить пароль</BaseButton>
                    <span v-if="password.done" class="text-sm text-green-600">Пароль изменён.</span>
                    <span v-else-if="password.error" class="text-sm text-red-500">{{ password.error }}</span>
                </div>
            </form>
        </BaseCard>
        <BaseCard class="p-6 flex flex-col gap-3 max-w-2xl">
            <div class="flex items-center gap-2">
                <Icon name="ph:telegram-logo" class="size-6 text-sky-500" />
                <h3 class="text-lg">Telegram-бот</h3>
            </div>
            <p class="text-sm text-gray-500">
                Спрашивайте о клиентах, сделках и задачах обычным текстом, присылайте фото карточек предприятий,
                получайте напоминания о задачах. Бот работает от вашего имени и с вашими правами в CRM.
            </p>
            <p v-if="bot.loading" class="text-sm text-gray-500">Загрузка…</p>
            <p v-else-if="bot.error" class="text-sm text-red-500">{{ bot.error }}</p>
            <template v-else-if="bot.status">
                <p v-if="!bot.status.enabled" class="text-sm text-gray-500">Бот пока не настроен на сервере.</p>
                <template v-else-if="bot.status.linked">
                    <p class="text-sm">
                        Подключено{{ bot.status.tg_username ? ` (@${bot.status.tg_username})` : "" }}.
                        Бот: <a :href="`https://t.me/${bot.status.bot_username}`" target="_blank" class="text-sky-500 hover:underline">@{{ bot.status.bot_username }}</a>
                    </p>
                    <div>
                        <BaseButton color="danger" variant="pastel" :loading="bot.busy" @click="unlinkBot">Отключить</BaseButton>
                    </div>
                </template>
                <template v-else>
                    <div class="flex flex-wrap items-center gap-3">
                        <BaseButton color="primary" :loading="bot.busy" @click="linkBot">Подключить Telegram</BaseButton>
                        <a v-if="bot.link" :href="bot.link" target="_blank" class="text-sm text-sky-500 hover:underline break-all">{{ bot.link }}</a>
                    </div>
                    <p v-if="bot.link" class="text-sm text-gray-500">
                        Откройте ссылку на телефоне и нажмите «Старт» в Telegram. Ссылка действует 15 минут, потом обновите эту страницу.
                    </p>
                </template>
            </template>
        </BaseCard>
        <WhatsAppConnect />
    </div>
</template>

<script lang="ts" setup>
import type { Group, User } from '~/types/user';
import WhatsAppConnect from '~/components/whatsapp/WhatsAppConnect.vue';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Профиль',
    subject: 'Profile',
});

useHead({
    title: 'Профиль'
});

const groupsService = useService('groups', {auth: true});
const user = useState<User>('user');

const { data: groups, isLoading: groupsLoading, run: runGroups } = useAsync<Group[]>([]);

const errors = ref({username: '', email: '', password: '', role: ''});

// PATCH /users/me/password (old + new password), available to every staff user
const usersService = useService('users', {auth: true});
const password = reactive({old: '', new: '', repeat: '', busy: false, done: false, error: '', errors: {old: '', new: '', repeat: ''}});

async function changePassword() {
    password.done = false;
    password.error = '';
    password.errors = {old: '', new: '', repeat: ''};
    if (!password.old) password.errors.old = 'Введите текущий пароль';
    if (password.new.length < 10) password.errors.new = 'Не меньше 10 символов';
    if (password.repeat !== password.new) password.errors.repeat = 'Пароли не совпадают';
    if (password.errors.old || password.errors.new || password.errors.repeat) return;

    password.busy = true;
    try {
        const answer: any = await usersService.patch('me/password', {old_password: password.old, new_password: password.new}).exec();
        // the new password signs out the other devices; this one goes on with the fresh token
        if (answer?.access_token) localStorage.setItem('token', answer.access_token);
        password.old = password.new = password.repeat = '';
        password.done = true;
    } catch (e) {
        password.error = botError(e);
    } finally {
        password.busy = false;
    }
}

type BotStatus = { enabled: boolean; bot_username: string | null; linked: boolean; tg_username: string | null };
const botService = useService('bot', {auth: true});
const bot = reactive({status: null as BotStatus | null, link: '', loading: true, busy: false, error: ''});

function botError(e: any) {
    const message = e?.data?.message ?? e?.message ?? 'Ошибка';
    return Array.isArray(message) ? message.join('; ') : String(message);
}

async function loadBot() {
    try {
        bot.status = await botService.get<BotStatus>('link').exec();
        bot.error = '';
    } catch (e) {
        bot.error = botError(e);
    } finally {
        bot.loading = false;
    }
}

async function linkBot() {
    bot.busy = true;
    try {
        const result = await botService.post<{ url: string }>('link', {}).exec();
        bot.link = result.url;
        window.open(result.url, '_blank');
    } catch (e) {
        bot.error = botError(e);
    } finally {
        bot.busy = false;
    }
}

async function unlinkBot() {
    bot.busy = true;
    try {
        bot.status = await botService.remove<BotStatus>('link').exec();
        bot.link = '';
    } catch (e) {
        bot.error = botError(e);
    } finally {
        bot.busy = false;
    }
}

onMounted(() => {
    runGroups(groupsService.find().exec());
    loadBot();
});

</script>

<style>
</style>
