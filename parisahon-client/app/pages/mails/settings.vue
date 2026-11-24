<template>
    <!-- on a phone the columns go one under the other: templates and signatures used to be cut off -->
    <div class="flex flex-col gap-6 lg:flex-row">
        <section class="w-full lg:max-w-xs">
            <div class="flex flex-col gap-4">
                <h2
                    class="text-sm uppercase font-semibold text-gray-900 dark:text-white"
                >
                    Почтовые ящики
                </h2>
                <!-- the user's own sender mailboxes: open one to change its password or remove it -->
                <Spinner v-if="transportersLoading" class="w-6 h-6"/>
                <ul v-if="transporters.length" class="flex flex-col gap-2">
                    <li v-for="transporter in transporters" :key="transporter.id">
                        <BaseButton
                            variant="pastel"
                            class="w-full justify-start"
                            :to="`/settings/transporters/${transporter.id}?from=/mails/settings`"
                        >
                            <Icon name="ph:envelope-simple" class="size-4 mr-1" />
                            <span class="truncate">{{ transporter.email }}</span>
                            <Icon v-if="!transporter.verified_at" name="ph:warning" class="size-4 ms-1 text-amber-500" title="Пароль не проверен: введите его заново" />
                        </BaseButton>
                    </li>
                </ul>
                <p v-else-if="!transportersLoading" class="text-xs text-muted-500 dark:text-muted-400">
                    Ящиков нет — добавьте свой, чтобы отправлять письма от своего имени. Пока письма уходят с общего ящика компании.
                </p>
                <BaseButton class="max-w-fit" to="/settings/transporters/new?from=/mails/settings">
                    <Icon name="ph:plus" class="size-4 mr-1" />
                    Добавить ящик
                </BaseButton>
            </div>
        </section>
        <section class="flex min-w-0 flex-1 flex-col gap-4">
            <BaseCard rounded="md" class="p-4">
                <h2 class="text-lg text-gray-900 dark:text-white">
                    Шаблоны писем
                </h2>
                <BaseParagraph size="sm">
                    Вы можете заранее создать шаблоны писем и использовать их
                    при отправке клиенту. После добавления шаблоны станут
                    доступны при отправке письма
                </BaseParagraph>
                <Spinner v-if="templatesLoading" class="w-6 h-6 mt-2"/>
                <ul v-if="templates.length" class="flex flex-col gap-2 max-w-sm w-full mt-4">
                    <li v-for="template in templates" class="w-full">
                        <BaseButton variant="pastel" class="w-full justify-start" @click="() => templateModal.open(template)">{{ template.name }}</BaseButton>
                    </li>
                </ul>
                <BaseButton class="mt-4" @click="templateModal.open">
                    <Icon name="ph:plus" class="size-4 mr-1" />
                    Добавить шаблон
                </BaseButton>
            </BaseCard>
            <BaseCard rounded="md" class="p-4">
                <h2 class="text-lg text-gray-900 dark:text-white">Подписи</h2>
                <BaseParagraph size="sm">
                    Создайте несколько подписей для своего бизнеса: для клиентов
                    и для партнеров
                </BaseParagraph>
                <div class="flex flex-col mt-4 gap-4 lg:flex-row">
                    <ul class="w-full lg:max-w-xs">
                        <li class="w-full">
                            <input
                                type="radio"
                                name="signature"
                                value=""
                                id="new-signature"
                                class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                @change="() => onSignatureSelect(undefined)"
                                checked
                            />
                            <label
                                for="new-signature"
                                class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start"
                            >
                                <Icon name="ph:plus" class="size-4 mr-1" />
                                Новая подпись
                            </label>
                        </li>
                        <Spinner v-if="signaturesLoading" class="w-6 h-6 mt-2"/>
                        <li
                            v-for="(sig, idx) in signatures"
                            class="w-full"
                            :key="idx"
                        >
                            <input
                                type="radio"
                                name="signature"
                                :value="sig.sign"
                                :id="'signature-' + idx"
                                class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                @change="() => onSignatureSelect(sig)"
                            />
                            <label
                                :for="'signature-' + idx"
                                class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start"
                            >
                                {{ sig.username }}
                            </label>
                        </li>
                    </ul>
                    <form
                        class="w-full max-w-md"
                        @submit.prevent="onSignatureSubmit"
                        novalidate
                    >
                        <!-- framed, as in a new letter: it used to be unclear where to type -->
                        <div class="mb-2 rounded-md border border-muted-300 bg-white dark:border-muted-700 dark:bg-transparent">
                            <Editor v-model="selectedSignature.sign" :error="errors.signatureBody" @update:model-value="(val: string) => onChange('signatureBody', val)" />
                        </div>
                        <BaseAutocomplete
                            placeholder="Пользователь"
                            :fixed="true"
                            :items="employees"
                            :properties="{label: 'username', value: 'id', sublabel: (u: User)  => u.group?.name}"
                            dropdown
                            v-model="selectedSignature.user"
                            :error="errors.user"
                            @change="(u?: User) => onChange('user', u?.id)"
                        />
                        <div class="flex justify-between mt-2">
                            <BaseButton type="submit" :loading="isLoadingMap.create" :disabled="isLoadingMap.create">
                                {{ selectedSignature.status === 'new' ? 'Создать' : 'Сохранить' }}
                            </BaseButton>
                            <BaseButton v-if="selectedSignature.status !== 'new'" color="danger" :loading="isLoadingMap.remove" @click="onSignatureRemove">Удалить</BaseButton>
                        </div>
                    </form>
                </div>
            </BaseCard>
        </section>
        <TemplateModal id="TemplateModal" @saved="onTemplateSaved" @deleted="onTemplateDeleted" />
    </div>
</template>

<script lang="ts" setup>
import Editor from '~/components/common/Editor.vue';
import Spinner from '~/components/common/Spinner.vue';
import TemplateModal from '~/components/mail/TemplateModal.vue';
import { useValidation } from '~/composables/useValidation';
import type { PaginatedResponse } from '~/types/generics';
import type { Signature,Template,Transporter } from '~/types/mail';
import { type User,UserRole } from '~/types/user';
import { required } from '~/utils/validation';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Настройки',
    subject: 'Mail',
});

useHead({
    title: 'Настройки',
});

const templateModal = useModal('TemplateModal');
const toast = useToast('GlobalToast');
const signService = useService('emails/signs', { auth: true });
const templateService = useService('emails/templates', { auth: true });
const userService = useService('users', { auth: true });
const selectedSignature = ref<{status: 'new' | 'old', sign: string, user?: Partial<User>}>({
    status: 'new',
    sign: '',
    user: undefined,
});
const { validate, onChange, errors } = useValidation({
    signatureBody: [required('Обязательное поле')],
    user: [required('Обязательное поле')],
});

const {
    data: templates,
    isLoading: templatesLoading,
    run: runTemplates,
} = useAsync<Template[]>([]);
const {
    data: signatures,
    isLoading: signaturesLoading,
    run: runSignagutures,
} = useAsync<Signature[]>([]);

const {
    data: transporters,
    isLoading: transportersLoading,
    run: runTransporters,
} = useAsync<Transporter[]>([]);
const transporterService = useService('emails/transporters', { auth: true });

const { runWithId, isLoadingMap } = useAsync();
const { run: runUsers, data: users } = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});

const employees = computed(() => {
    return users.value.data.filter((u) => u.role !== UserRole.CtrAgent && !signatures.value.some((s) => s.user_id === u.id));
});

function onTemplateSaved(template: Template, isNew: boolean) {
    if (isNew) templates.value.push(template);
    else templates.value = templates.value.map((t) => t.id === template.id ? template : t);
}

function onTemplateDeleted(id: number) {
    templates.value = templates.value.filter((t) => t.id !== id);
}

async function onSignatureSubmit() {
    const validationResult = validate({
        user: selectedSignature.value?.user?.id,
        signatureBody: selectedSignature.value?.sign,
    });

    if (!validationResult.valid) return;

    const result = await promiseResult(runWithId(signService.patch('', {
        user_id: selectedSignature.value?.user?.id,
        sign: selectedSignature?.value.sign,
    }).exec(), 'create'));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});

    const values = {
        sign: selectedSignature.value.sign,
        user_id: selectedSignature.value?.user?.id!,
        username: selectedSignature.value?.user?.username!,
    };

    if (selectedSignature.value.status === 'new') {
        signatures.value.push(values);
        selectedSignature.value = {
            sign: '',
            user: undefined,
            status: 'new',
        };
    } else {
        signatures.value = signatures.value.map((s) => s.user_id === selectedSignature.value?.user?.id ? values : s);
    }
}

async function onSignatureRemove() {
    const result = await promiseResult(runWithId(signService.remove(selectedSignature.value?.user?.id!).exec(), 'remove'));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    signatures.value = signatures.value.filter((s) => s.user_id !== selectedSignature.value?.user?.id);
}

function onSignatureSelect(sig?: Signature) {
    if (!sig) {
        selectedSignature.value = {
            sign: '',
            user: undefined,
            status: 'new',
        };
    } else {
        selectedSignature.value = {
            sign: sig.sign,
            user: {
                id: sig.user_id,
                username: sig.username,
            },
            status: 'old'
        };
    }
}

onMounted(() => {
    runTemplates(templateService.find().exec());
    runSignagutures(signService.find().exec());
    runTransporters(transporterService.find().exec());
    runUsers(userService.find({ limit: 1000 }).exec());
});
</script>