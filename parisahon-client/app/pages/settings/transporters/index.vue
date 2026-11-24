<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">Почтовые ящики</h1>
            <h2 class="text-sm text-gray-500">
                Ящики, с которых сотрудники отправляют письма. Сотрудник подключает только свой ящик и только с паролем,
                который принял почтовый сервер; чужой ящик подключает администратор.
            </h2>
        </div>
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex items-center gap-4">
            </div>
            <NuxtLink
                :to="{name: 'settings-transporters-id', params: {id: 'new'}}"
                class="border border-gray-300 dark:border-muted-600 rounded-md"
            >
                <BaseButton color="primary">
                    Добавить ящик
                </BaseButton>
            </NuxtLink>
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                :columns="columns"
                :data="transporters"
                :loading="isLoading"
                :sort-by="[]"
                class="flex-auto"
                id="transporters"
            >
                <template #owner="{item}">
                    <span>{{ item.created_by?.username ?? '-' }}</span>
                    <span v-if="item.created_by?.email" class="block text-xs text-muted-400">{{ item.created_by.email }}</span>
                </template>
                <template #verified_at="{item}">
                    <BaseTag v-if="item.verified_at" color="success" variant="pastel" size="sm">Проверен</BaseTag>
                    <BaseTag v-else color="warning" variant="pastel" size="sm">Не проверен: письма ящика не видны, введите пароль заново</BaseTag>
                </template>
                <template #actions="{item}">
                    <BaseButtonIcon v-if="!item.created_by || item.created_by.id === currentUser?.id" size="sm" :to="{name: 'settings-transporters-id', params: {id: item.id}}">
                        <Icon
                            class="w-5 h-5"
                            name="ph:pencil-simple"
                        />
                    </BaseButtonIcon>
                    <BaseButtonIcon v-else size="sm" color="danger" :disabled="deleting === item.id" @click="() => onDelete(item)">
                        <Icon
                            class="w-5 h-5"
                            name="ph:trash"
                        />
                    </BaseButtonIcon>
                </template>
            </BaseTable>
        </div>
    </div>
</template>

<script lang="ts" setup>
import BaseTable from '~/components/common/BaseTable.vue';
import {type Column} from '~/components/common/types';
import { useAsync } from '~/composables/useAsync';
import type { Transporter } from '~/types/mail';
import type { User } from '~/types/user';
import { promiseResult } from '~/utils/result';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Почтовые ящики',
    roles: ['admin'],
    subject: 'Mail'
});

useHead({
    title: 'Почтовые ящики'
});

const transporterService = useService('emails/transporters', {auth: true});
const toast = useToast('GlobalToast');
const currentUser = useState<User>('user');
// the admin sees every employee's mailboxes (whose it is, whether the mail server accepted it)
const { data: transporters, isLoading, run } = useAsync<Transporter[]>([]);
const deleting = ref<number | null>(null);
const columns = ref<Column[]>([
    {
        label: 'Почта',
        name: 'email',
        resizable: true,
        headerStyle: {
            minWidth: '200px',
        }
    },
    {
        label: 'Сотрудник',
        name: 'owner',
        headerStyle: {
            minWidth: '180px',
        }
    },
    {
        label: 'Пароль',
        name: 'verified_at',
        headerStyle: {
            minWidth: '160px',
        }
    },
    {
        label: 'Дата создания',
        name: 'created_at',
        dateFormat: 'MMM Do, HH:mm',
        headerStyle: {
            minWidth: '200px',
        }
    },
    {
        label: '',
        name: 'actions',
        headerStyle: {
            width: '100px'
        }
    }
]);

/** A mailbox of another employee: the admin may only remove it (its password is the employee's). */
async function onDelete(item: Transporter) {
    if (!confirm(`Отключить ящик ${item.email} сотрудника ${item.created_by?.username ?? ''}?`)) return;
    deleting.value = item.id;
    const result = await promiseResult(transporterService.remove(item.id).exec());
    deleting.value = null;
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 4000 });
    transporters.value = transporters.value.filter((t) => t.id !== item.id);
}

onMounted(() => {
    run(transporterService.find({ all: true }).exec());
});
</script>

<style>
</style>
