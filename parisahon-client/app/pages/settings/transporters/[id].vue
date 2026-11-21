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
            label="Пароль"
            name="password"
            icon="ph:key"
            :loading="isLoading"
            required
        />
        <div class="flex flex-col mt-4 gap-2">
            <BaseButton v-if="transporter.id" color="danger" :disabled="deleting" @click="onDelete">Удалить</BaseButton>
            <BaseButton color="primary" type="submit" :disabled="saving">Сохранить</BaseButton>
        </div>
    </form>
</template>

<script lang="ts" setup>
import { useRoute } from 'vue-router';

import BaseButton from '~/components/base/BaseButton.vue';
import { useAsync } from '~/composables/useAsync';
import { useService } from '~/composables/useService';
import type { Transporter } from '~/types/mail';
import { promiseResult } from '~/utils/result';

const transporterService = useService('emails/transporters', {auth: true});

const route = useRoute();
const { data: transporter, run, isLoading } = useAsync<Transporter>({});
const { runAsync: saveAsync, isLoading: saving } = useAsync<Transporter>({});
const { runAsync: deleteAsync, isLoading: deleting } = useAsync<Transporter>({});

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Транпортер',
    subject: 'Mail'
});

useHead({
    title: 'Транспортер'
});

const toast = useToast('GlobalToast');

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
    const email = formData.get('email');
    const password = formData.get('password');
    let promise;
    if (id) promise = transporterService.patch(id as string, { email, password }).exec();
    else promise = transporterService.create({ email, password }).exec();
    const result = await promiseResult(saveAsync(promise));
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 3000 });
    if (route.query.from) navigateTo(route.query.from as string);
    else navigateTo('/settings/transporters');
}

onMounted(() => {
    if (route.params.id !== 'new') run(transporterService.get(route.params.id as string).exec());
});

</script>

<style scoped>

</style>
