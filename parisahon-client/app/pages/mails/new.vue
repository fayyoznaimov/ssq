<template>
    <div class="max-w-3xl">
        <form @submit.prevent="onSend" id="email-form"></form>
        <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-3">
                <BaseSelect :loading="transportersLoading" name="transporter_id" form="email-form" label="От" v-model="transporterId">
                    <option v-for="transporter of transporters" :value="String(transporter.id)">{{ transporter.email }}</option>
                    <option value="">Общий ящик компании</option>
                </BaseSelect>
                <p v-if="!transportersLoading && !transporters?.length" class="text-sm text-muted-500 dark:text-muted-400">
                    Письмо уйдёт с общего ящика компании. Свой ящик можно подключить в <NuxtLink to="/mails/settings" class="underline">Почта → Настройки</NuxtLink>.
                </p>
                <form @submit.prevent="onRecepientSubmit" ref="toFormRef">
                    <input type="hidden" name="key" value="to">
                    <BaseInput
                        label="Кому *"
                        type="text"
                        icon="ph:envelope-simple"
                        name="email"
                        placeholder="адрес и Enter, можно несколько через запятую"
                        :required="recepients.to.length < 1"
                    />
                </form>
                <div v-if="recepients.to.length" class="flex flex-wrap gap-2">
                    <template v-for="(email, i) in recepients.to">
                        <BaseSnack size="sm" @delete="() => recepients.to.splice(i, 1)">{{ email }}</BaseSnack>
                        <input type="hidden" name="to[]" :value="email" form="email-form" />
                    </template>
                </div>
                <form @submit.prevent="onRecepientSubmit" ref="ccFormRef">
                    <input type="hidden" name="key" value="cc">
                    <BaseInput
                        label="CC"
                        type="text"
                        icon="ph:at"
                        name="email"
                        placeholder="адрес и Enter, можно несколько через запятую"
                    />
                </form>
                <div v-if="recepients.cc.length" class="flex flex-wrap gap-2">
                    <template v-for="(email, i) in recepients.cc">
                        <BaseSnack size="sm" @delete="() => recepients.cc.splice(i, 1)">{{ email }}</BaseSnack>
                        <input type="hidden" name="cc[]" :value="email" form="email-form" />
                    </template>
                </div>
                <BaseInput label="Тема" name="subject" v-model="emailSubject" form="email-form" />
                <BaseSelect v-if="templates.length" label="Шаблон" v-model="template" placeholder="Выберите шаблон" :loading="templatesLoading" form="email-form">
                    <option v-for="template of templates" :value="template.id">{{ template.name }}</option>
                </BaseSelect>
                <div class="bg-white dark:bg-transparent text-sm rounded-md border border-muted-300 dark:border-muted-700 pb-2">
                    <Editor v-model="emailBody" form="email-form" />
                    <SignaturePreview v-model="withSignature" />
                    <MailAssistant v-model:body="emailBody" v-model:subject="emailSubject" />
                </div>
            </div>
            <div class="self-start">
                <BaseButton
                    color="primary"
                    type="submit"
                    form="email-form"
                    :loading="isLoading"
                    :disabled="isLoading"
                >
                    <Icon name="ph:paper-plane" class="me-2" />
                    Отправить
                </BaseButton>
            </div>
        </div>
    </div>
</template>

<script lang="ts" setup>
import type BaseSnack from '~/components/base/BaseSnack.vue';
import Editor from '~/components/common/Editor.vue';
import BaseSelect from '~/components/form/BaseSelect.vue';
import MailAssistant from '~/components/mail/MailAssistant.vue';
import SignaturePreview from '~/components/mail/SignaturePreview.vue';
import { useAsync } from '~/composables/useAsync';
import type { Template, Transporter } from '~/types/mail';
import { promiseResult } from '~/utils/result';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Новое Письмо',
    subject: 'Mail'
});

useHead({
    title: 'Письмо'
});

// "" = the shared mailbox of the company; the user's own mailbox when there is one
const transporterId = ref('');
const toFormRef = ref();
const ccFormRef = ref();
const mailService = useService('emails', {auth: true});
const transporterService = useService('emails/transporters', {auth: true});
const templateService = useService('emails/templates', {auth: true});
const toast = useToast('GlobalToast');
const emailBody = ref('');
const emailSubject = ref('');
const template = ref();
// the server adds the signature under the text (in the editor it lost its formatting)
const withSignature = ref(true);
const recepients = reactive<{cc: string[], to: string[]}>({cc: [], to: []});
const { runAsync, isLoading } = useAsync();
const { run, data: transporters, isLoading: transportersLoading } = useAsync<Transporter[]>([]);
const { data: templates, isLoading: templatesLoading, run: runTemplates } = useAsync<Template[]>([]);

/** "a@b.uz, c@d.uz; e@f.uz" -> three addresses */
function splitAddresses(value: unknown): string[] {
    return String(value ?? '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function onRecepientSubmit(e: Event) {
    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);
    const key = formData.get('key') as 'cc' | 'to';
    for (const email of splitAddresses(formData.get('email'))) {
        if (!recepients[key].includes(email)) recepients[key].push(email);
    }
    form.reset();
}

let lastTemplate: Template;
watch(template, (id) => {
    const found = templates.value.find((t) => t.id === id);
    if (found) {
        emailBody.value = found.template_body + emailBody.value;
        emailSubject.value = found.subject;
        lastTemplate = found;
    }
});

watch(transporters, () => {
    // no sender account: the letter goes from the shared mailbox
    transporterId.value = transporters.value?.[0]?.id ? String(transporters.value[0].id) : '';
});

async function onSend(e: Event) {
    toFormRef.value.reportValidity();
    if (!toFormRef.value.checkValidity()) {
        return;
    }

    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const ccEmail = new FormData(ccFormRef.value).get('email');
    const toEmail = new FormData(toFormRef.value).get('email');

    // what is typed but not yet added with Enter goes too
    for (const address of splitAddresses(toEmail)) formData.append('to[]', address);
    for (const address of splitAddresses(ccEmail)) formData.append('cc[]', address);
    if (!formData.get('transporter_id')) formData.delete('transporter_id');

    formData.append('body', emailBody.value ?? '');
    formData.append('with_signature', withSignature.value ? 'true' : 'false');

    const result = await promiseResult(runAsync(mailService.create(formData).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 5000});
    toast.show({message: 'Письмо отправлено', type: 'success', timeout: 3000});
    navigateTo('/mails');
}

onMounted(() => {
    run(transporterService.find().exec());
    runTemplates(templateService.find().exec());
});

</script>
