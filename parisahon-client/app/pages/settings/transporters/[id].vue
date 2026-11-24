<template>
    <form class="mt-4 px-10 max-w-md flex flex-col gap-3" @submit.prevent="onSave">
        <input v-if="transporter.id" type="hidden" :value="transporter.id" name="id">
        <BaseInput
            type="email"
            v-model="transporter.email"
            label="Почта"
            name="email"
            placeholder="пр.: help@parisahome.com"
            icon="ph:envelope-simple"
            :loading="isLoading"
            required
        />
        <BaseInput
            type="password"
            :label="transporter.id ? 'Пароль (пусто — оставить прежний)' : 'Пароль'"
            name="password"
            icon="ph:key"
            :loading="isLoading"
            :required="!transporter.id"
        />
        <!-- MAIL-6: the mailbox shows its letters to its owner, so only one's own and only with a password the server accepts -->
        <p class="text-xs text-muted-500 dark:text-muted-400">
            <template v-if="isAdmin">Администратор может подключить любой ящик компании.</template>
            <template v-else>Можно подключить только свой ящик — адрес вашей учётной записи{{ user?.email ? ` (${user.email})` : '' }}.</template>
            При сохранении адрес и пароль проверяются на почтовом сервере: ящик с неверным паролем не сохранится.
        </p>
        <p v-if="transporter.id && !transporter.verified_at" class="text-xs text-amber-600 dark:text-amber-400">
            Пароль этого ящика ещё не проверен: его письма не видны в «Почте». Введите пароль и сохраните.
        </p>
        <div class="flex flex-col mt-4 gap-2">
            <BaseButton v-if="transporter.id" color="danger" :disabled="deleting" @click="onDelete">Удалить</BaseButton>
            <BaseButton color="primary" type="submit" :disabled="saving" :loading="saving">Проверить и сохранить</BaseButton>
        </div>
    </form>
</template>

<script lang="ts" setup>
import { useRoute } from 'vue-router';

import BaseButton from '~/components/base/BaseButton.vue';
import { useAsync } from '~/composables/useAsync';
import { useService } from '~/composables/useService';
import type { Transporter } from '~/types/mail';
import { type User, UserRole } from '~/types/user';
import { promiseResult } from '~/utils/result';

const transporterService = useService('emails/transporters', {auth: true});

const route = useRoute();
const { data: transporter, run, isLoading } = useAsync<Transporter>({});
const { runAsync: saveAsync, isLoading: saving } = useAsync<Transporter>({});
const { runAsync: deleteAsync, isLoading: deleting } = useAsync<Transporter>({});

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Почтовый ящик',
    subject: 'Mail'
});

useHead({
    title: 'Почтовый ящик'
});

const toast = useToast('GlobalToast');
const user = useState<User>('user');
const isAdmin = computed(() => user.value?.role === UserRole.Admin);

async function onDelete() {
    const result = await promiseResult(deleteAsync(transporterService.remove(transporter.value.id).exec()));
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 3000 });
    if (route.query.from) navigateTo(route.query.from as string);
    else navigateTo('/settings/transporters');
}

async function onSave(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const id = formData.get('id');
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    let promise;
    // an empty password on edit keeps the saved one (the API checks it again when the address changes)
    if (id) promise = transporterService.patch(id as string, password ? { email, password } : { email }).exec();
    else promise = transporterService.create({ email, password }).exec();
    const result = await promiseResult(saveAsync(promise));
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 7000 });
    toast.show({ message: 'Почтовый сервер принял ящик, он сохранён', type: 'success', timeout: 3000 });
    if (route.query.from) navigateTo(route.query.from as string);
    else navigateTo('/settings/transporters');
}

onMounted(() => {
    if (route.params.id !== 'new') run(transporterService.get(route.params.id as string).exec());
    // a new mailbox of an employee is their own address
    else if (!isAdmin.value && user.value?.email) transporter.value = { ...transporter.value, email: user.value.email } as Transporter;
});

</script>

<style scoped>

</style>
