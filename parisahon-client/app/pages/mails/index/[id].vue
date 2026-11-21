<template>
    <section class="w-full flex flex-col relative h-full dark:bg-muted-800">
        <div class="p-4 border-b border-b-muted-200 dark:border-muted-700 flex justify-between items-center">
            <BaseHeading as="h2" weight="normal">{{ email.subject }}</BaseHeading>
            <div class="flex gap-6">
                <div class="flex gap-2">
                    <BaseAutocomplete
                        v-if="choosingDeal"
                        v-model="selectedDeal"
                        placeholder="Сделки"
                        :fixed="true"
                        :items="deals.data"
                        :properties="{label: 'label', value: 'id'}"
                        :display-value="(deal: Deal) => deal?.label ?? ''"
                        dropdown
                        clearable
                        @input="onDealInput"
                        :classes="{wrapper: 'max-w-xs'}"
                    />
                    <BaseButton v-if="!choosingDeal" @click="choosingDeal = true">Привязать сделку</BaseButton>
                    <BaseButtonClose v-else size="md" rounded="md" color="muted" class="shrink-0" @click="choosingDeal = false; selectedDeal = undefined" />
                </div>
                <BaseDropdown
                    variant="context"
                    label="Dropdown"
                    placement="bottom-start"
                >
                    <BaseDropdownItem
                        title="Отметить как спам"
                        class="hover:bg-muted-100 rounded-md duration-300 dark:hover:bg-muted-900"
                        @click="markAsSpam"
                    />
                </BaseDropdown>
            </div>
        </div>
        <div class="h-[calc(100%-5rem)] overflow-y-auto">
            <ul class="flex flex-col py-2 px-4 mb-[28rem]">
                <li class="dark:bg-muted-700 border border-muted-200 dark:border-muted-600 rounded-md">
                    <details class="group">
                        <summary class="p-2 flex gap-2">
                            <Icon name="ph:envelope-simple-open" class="size-8"/>
                            <div>
                                <p class="text-[13px] text-muted-600 dark:text-muted-400">
                                    {{ new Date(email.sent_at).toLocaleString('ru') }}
                                    {{ email.outgoing ? 'Исходящее письмо' : 'Входящее письмо' }} от: {{ email.from }}
                                    кому: {{ email.to.map((r) => r.value.split('@')[0]).join(', ') }}
                                </p>
                                <p class="text-[15px] text-muted-900 underline dark:text-white">{{ email.subject }}</p>
                                <p class="text-[15px] text-muted-900 dark:text-white group-open:hidden">{{ email.sanitized?.snippet }}</p>
                            </div>
                        </summary>
                        <div class="flex flex-col ml-12">
                            <pre class="text-muted-900 text-[15px] whitespace-pre-line dark:text-white" v-html="email.sanitized?.body"></pre>
                            <ul class="flex items-center gap-2 py-6 mt-auto flex-wrap">
                                <li v-for="file of email.files" class="basis-44">
                                    <a :href="fileUrl(file.path)" target="_blank" class="flex items-center gap-2 p-2 rounded-md bg-muted-50 w-full text-sm dark:bg-muted-800">
                                        <Icon :name="getAttachmentIcon(file.name)" class="size-6" />
                                        <div class="flex flex-col">
                                            <span class="text-muted-900 line-clamp-1 dark:text-white">{{ file.name }}</span>
                                        </div>
                                    </a>
                                </li>
                            </ul>
                        </div>
                    </details>
                </li>
            </ul>
        </div>
        <section class="absolute bottom-0 shadow-md w-full p-4 bg-white dark:bg-muted-800">
            <form class="rounded-md border border-muted-200 dark:border-muted-700 pb-2.5" @submit.prevent="onSend">
                <details ref="detailsRef" class="group">
                    <summary class="p-2.5 text-sm group-open:hidden">
                        <span class="text-muted-500 dark:text-muted-300">Email для: </span><span class="text-muted-900 dark:text-white">{{ email.from }}</span>
                    </summary>
                    <div class="text-sm">
                        <ul class="border-b border-b-muted-200 dark:border-b-muted-700">
                            <li class="p-2.5 text-sm">
                                <span class="text-muted-500 dark:text-muted-300">Email для: </span><span class="text-muted-900 dark:text-white">{{ email.from }}</span>
                                <input type="hidden" name="to[]" v-model="email.from">
                            </li>
                            <li class="flex items-center space-x-2 px-2.5 border-t border-t-muted-200 dark:border-t-muted-700">
                                <label class="text-muted-500 dark:text-muted-300" for="cc">Копия: </label>
                                <input id="cc" class="outline-none py-2 text-muted-900 w-full bg-transparent dark:text-white" name="cc[]" />
                            </li>
                            <li class="flex items-center space-x-2 px-2.5 border-t border-t-muted-200 dark:border-t-muted-700">
                                <label class="text-muted-500 dark:text-muted-300" for="subject">Тема: </label>
                                <input id="subject" class="outline-none py-2 text-muted-900 w-full bg-transparent dark:text-white" v-model="emailSubject" name="subject" />
                            </li>
                            <li class="flex items-center px-2.5 border-t border-t-muted-200 dark:border-t-muted-700">
                                <label class="text-muted-500 dark:text-muted-300" for="subject">От: </label>
                                <select id="subject" class="p-2 outline-none text-muted-900 appearance-none w-full bg-transparent dark:text-white dark:bg-muted-800" name="transporter_id">
                                    <option v-for="transporter in transporters" :value="transporter.id">
                                        {{ transporter.email }}
                                    </option>
                                </select>
                            </li>
                            <li class="flex items-center px-2.5 border-t border-t-muted-200 dark:border-t-muted-700" v-if="!templatesLoading && templates.length">
                                <label class="text-muted-500 dark:text-muted-300" for="subject">Шаблон: </label>
                                <select class="p-2 outline-none text-muted-900 appearance-none w-full bg-transparent dark:text-white dark:bg-muted-800" @change="onTemplateChange">
                                    <option value="">...</option>
                                    <option :value="template.id" v-for="template in templates">
                                        {{ template.name }}
                                    </option>
                                </select>
                            </li>
                        </ul>
                        <Editor v-model="emailBody" />
                        <div class="flex gap-2">
                            <BaseButton color="primary" type="submit" class="ml-2.5" :disabled="sending">Отправить</BaseButton>
                            <BaseButton variant="pastel" @click="toggleEditor">Отменить</BaseButton>
                        </div>
                    </div>
                </details>
            </form>
            <form class="flex flex-col gap-4" @submit.prevent="onSend" v-if="false">
                <input type="hidden" name="subject" :value="email.subject">
                <input v-for="cc in email.cc" type="hidden" name="cc[]" :value="cc.value">
                <input v-for="to in email.to" type="hidden" name="to[]" :value="to.value">
                <Editor v-model="emailBody" />
                <BaseButton color="primary" class="self-end" type="submit" :disabled="sending">Отправить</BaseButton>
            </form>
        </section>
    </section>
</template>

<script lang="ts" setup>
import { useRoute } from 'vue-router';

import type BaseHeading from '~/components/base/BaseHeading.vue';
import Editor from '~/components/common/Editor.vue';
import { useAsync } from '~/composables/useAsync';
import type { Deal } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';
import type { Email, Signature, Template, Transporter } from '~/types/mail';
import type { User } from '~/types/user';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Письмо',
    subject: 'Mail'
});

useHead({
    title: 'Письмо'
});

const props = defineProps<{
    email?: Email;
}>();

const route = useRoute();
const mailService = useService('emails', {auth: true});
const templateService = useService('emails/templates', {auth: true});
const transporterService = useService('emails/transporters', {auth: true});
const signatureService = useService('emails/signs', {auth: true});
const dealService = useService('deals', {auth: true});

const toast = useToast('GlobalToast');
const { data: email, run } = useAsync<Email>(props.email ? props.email : {to: [], cc: []});
const { data: templates, isLoading: templatesLoading, run: runTemplates } = useAsync<Template[]>([]);
const { data: deals, run: runDeals } = useAsync<PaginatedResponse<Deal>>({
    data: [],
});
const { data: transporters, run: runTransporters } = useAsync<Transporter[]>([]);
const { data: signature, run: runSignature } = useAsync<Signature>();
const { runAsync, isLoading: sending } = useAsync();

const user = useState<User>('user');
const emailSubject = ref();
const emailBody = ref<string>('');
const detailsRef = ref();
const choosingDeal = ref(false);
// The deal picked in "Привязать сделку": the reply goes into its history too
const selectedDeal = ref<Deal>();
const lastTemplate = ref<Template>();

async function onSend(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const cc = formData.get('cc[]');
    if (!cc) formData.delete('cc[]');
    formData.append('body', emailBody.value);
    if (selectedDeal.value?.id) formData.append('deal_id', String(selectedDeal.value.id));
    const result = await promiseResult(runAsync(mailService.create(formData).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    toast.show({message: 'Письмо отправлено', type: 'success', timeout: 3000});
    target.reset();
    navigateTo('/mails');
}

function onTemplateChange(e: Event) {
    const target = e.target as HTMLFormElement;
    const template = templates.value.find((t) => t.id === Number(target.value));
    // let body = emailBody.value;
    // if (lastTemplate.value) body = body.slice(lastTemplate.value.template_body.length);
    if (template) {
        emailBody.value = template.template_body + emailBody.value;
        emailSubject.value = template.subject;
        lastTemplate.value = template;
    } 
}

function getAttachmentIcon(fileName: string): string {
    const extension = fileName?.split('.').pop()?.toLowerCase() || '';
    switch (extension) {
        case 'pdf':
            return 'ph:file-pdf';
        case 'doc':
        case 'docx':
            return 'ph:file-doc';
        case 'js':
            return 'ph:file-js';
        case 'xls':
        case 'xlsx':
            return 'ph:file-xls';
        case 'ppt':
        case 'pptx':
            return 'ph:file-ppt';
        case 'jpg':
        case 'jpeg':
        case 'png':
        case 'gif':
            return 'ph:image-square';
        default:
            return 'ph:file';
    }
}

function fileUrl(path: string) {
    return useApiUrl() + '/uploads/' + path;
}

const onDealInput = debounce((e: Event) => {
    const target = (e.target as HTMLInputElement);
    runDeals(dealService.find({ label: target.value }).exec());
}, 300);

function toggleEditor() {
    detailsRef.value.removeAttribute('open');
}

async function markAsSpam() {
    const result = await promiseResult(mailService.patch(`${email.value.id}/mark-as-spam`, '').exec());
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
}

watchEffect(() => {
    if (email.value?.subject) emailSubject.value = 'Re: ' + email.value.subject;
});

watchEffect(() => {
    if (signature.value?.sign) {
        emailBody.value = `<br>${signature.value.sign}`;
    }
});

watchEffect(() => {
    if (choosingDeal.value && !deals.value.data.length) runDeals(dealService.find().exec());
});

onMounted(() => {
    if (route.params.id) {
        run(mailService.get(route.params.id as string).exec());
    }
    runTemplates(templateService.find().exec());
    runTransporters(transporterService.find().exec());
    runSignature(signatureService.get(user.value.id).exec());
});

</script>
