<template>
    <section class="w-full flex flex-col relative h-full dark:bg-muted-800">
        <div class="p-4 border-b border-b-muted-200 dark:border-muted-700 flex flex-wrap gap-3 justify-between items-center">
            <div class="flex flex-col gap-1 min-w-0">
                <BaseHeading as="h2" weight="normal" class="break-words">{{ email.subject }}</BaseHeading>
                <!-- who the letter is with and the deals it is in -->
                <div v-if="email.client?.contact || email.client?.company || email.deals?.length" class="flex flex-wrap items-center gap-2 text-sm">
                    <NuxtLink
                        v-if="email.client?.contact"
                        :to="'/lists/contacts/' + email.client.contact.id"
                        class="inline-flex items-center gap-1 text-muted-700 hover:text-primary-600 hover:underline dark:text-muted-200"
                    >
                        <Icon name="ph:user" class="size-4" />{{ email.client.contact.username }}
                    </NuxtLink>
                    <NuxtLink
                        v-if="email.client?.company"
                        :to="'/lists/companies/' + email.client.company.id"
                        class="inline-flex items-center gap-1 text-muted-700 hover:text-primary-600 hover:underline dark:text-muted-200"
                    >
                        <Icon name="ph:buildings" class="size-4" />{{ email.client.company.name }}
                    </NuxtLink>
                    <NuxtLink
                        v-for="deal of email.deals ?? []"
                        :key="deal.id"
                        :to="'/deals/' + deal.id"
                        class="inline-flex items-center gap-1 rounded-md bg-muted-100 px-2 py-0.5 text-muted-800 hover:text-primary-600 dark:bg-muted-700 dark:text-muted-100"
                    >
                        <Icon name="ph:currency-circle-dollar" class="size-4" />№{{ deal.display_id }} {{ deal.label }}
                        <span v-if="deal.closed" class="text-xs text-muted-400">(закрыта)</span>
                    </NuxtLink>
                </div>
            </div>
            <div class="flex gap-3 items-center">
                <!-- a letter of no deal («Неразобранные»): into a deal and / or its sender to a contact -->
                <BaseButton v-if="!choosingDeal && email.id && !email.deals?.length" size="sm" @click="choosingDeal = true">
                    <Icon name="ph:link" class="size-4 me-1" />
                    Привязать
                </BaseButton>
                <BaseDropdown
                    variant="context"
                    label="Dropdown"
                    placement="bottom-start"
                >
                    <BaseDropdownItem
                        v-if="email.deleted_at"
                        title="Восстановить"
                        class="hover:bg-muted-100 rounded-md duration-300 dark:hover:bg-muted-900"
                        @click="restore"
                    />
                    <BaseDropdownItem
                        v-else-if="email.is_spam"
                        title="Не спам"
                        class="hover:bg-muted-100 rounded-md duration-300 dark:hover:bg-muted-900"
                        @click="markAsNotSpam"
                    />
                    <BaseDropdownItem
                        v-else
                        title="Отметить как спам"
                        class="hover:bg-muted-100 rounded-md duration-300 dark:hover:bg-muted-900"
                        @click="markAsSpam"
                    />
                </BaseDropdown>
            </div>
        </div>
        <div
            v-if="choosingDeal"
            class="p-4 border-b border-b-muted-200 dark:border-muted-700 flex flex-col gap-3 bg-muted-50 dark:bg-muted-900"
        >
            <p class="text-sm text-muted-600 dark:text-muted-300">
                Письмо попадёт в историю выбранной сделки. Если выбрать контакт, адрес {{ counterpart || 'отправителя' }} станет его адресом:
                прежние и следующие письма с этого адреса будут привязываться сами.
            </p>
            <div class="flex flex-col gap-2 lg:flex-row lg:items-end">
                <BaseAutocomplete
                    v-model="selectedDeal"
                    label="Сделка"
                    placeholder="Название или номер сделки"
                    :fixed="true"
                    :items="deals.data"
                    :properties="{label: 'label', value: 'id', sublabel: (deal: Deal) => `№${deal.display_id ?? deal.id}`}"
                    :display-value="(deal: Deal) => deal?.label ?? ''"
                    dropdown
                    clearable
                    :classes="{wrapper: 'w-full lg:max-w-xs'}"
                    @input="onDealInput"
                />
                <BaseAutocomplete
                    v-if="!email.outgoing"
                    v-model="selectedContact"
                    label="Контакт"
                    placeholder="Имя, телефон или почта"
                    :fixed="true"
                    :items="contacts"
                    :properties="{label: 'username', value: 'id', sublabel: (contact: any) => contact.company?.name ?? contact.email ?? ''}"
                    :display-value="(contact: any) => contact?.username ?? ''"
                    dropdown
                    clearable
                    :classes="{wrapper: 'w-full lg:max-w-xs'}"
                    @input="onContactInput"
                />
                <div class="flex gap-2">
                    <BaseButton color="primary" :loading="linkBusy" :disabled="linkBusy || (!selectedDeal && !selectedContact)" @click="onLink">Привязать</BaseButton>
                    <BaseButton variant="pastel" @click="choosingDeal = false; selectedDeal = undefined; selectedContact = undefined">Отмена</BaseButton>
                </div>
            </div>
        </div>
        <div class="h-[calc(100%-5rem)] overflow-y-auto">
            <ul class="flex flex-col py-2 px-4 mb-[28rem]">
                <li class="dark:bg-muted-700 border border-muted-200 dark:border-muted-600 rounded-md">
                    <details class="group" open>
                        <summary class="p-2 flex gap-2">
                            <Icon name="ph:envelope-simple-open" class="size-8 shrink-0"/>
                            <div class="min-w-0">
                                <p class="text-[13px] text-muted-600 dark:text-muted-400 break-words">
                                    {{ email.sent_at ? new Date(email.sent_at).toLocaleString('ru') : '' }}
                                    {{ email.outgoing ? 'Исходящее письмо' : 'Входящее письмо' }} от: {{ email.from_name ? `${email.from_name} <${email.from}>` : email.from }}
                                    кому: {{ (email.to ?? []).map((r) => r.value).join(', ') }}
                                    <template v-if="email.cc?.length">копия: {{ email.cc.map((r) => r.value).join(', ') }}</template>
                                </p>
                                <p class="text-[15px] text-muted-900 underline dark:text-white">{{ email.subject }}</p>
                                <p class="text-[15px] text-muted-900 dark:text-white group-open:hidden">{{ sanitized.snippet }}</p>
                            </div>
                        </summary>
                        <div class="flex flex-col ml-12 mr-2 min-w-0">
                            <!-- HTML letters: cleaned (utils/sanitize.ts); text letters as text, so "<ivan@x>" stays -->
                            <div v-if="view.html" class="mail-html text-muted-900 text-[15px] dark:text-white overflow-x-auto" v-html="view.main"></div>
                            <div v-else class="text-muted-900 text-[15px] whitespace-pre-line break-words dark:text-white">{{ view.main }}</div>
                            <div v-if="view.quote" class="mt-3">
                                <button type="button" class="text-xs text-primary-600 hover:underline dark:text-primary-300" @click="showQuote = !showQuote">
                                    {{ showQuote ? 'Скрыть цитату' : 'Показать цитату' }}
                                </button>
                                <template v-if="showQuote">
                                    <div v-if="view.html" class="mail-html mt-2 border-l-2 border-muted-300 pl-3 text-muted-600 text-[14px] dark:text-muted-300 overflow-x-auto" v-html="view.quote"></div>
                                    <div v-else class="mt-2 border-l-2 border-muted-300 pl-3 text-muted-600 text-[14px] whitespace-pre-line break-words dark:text-muted-300">{{ view.quote }}</div>
                                </template>
                            </div>
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
                        <span class="text-muted-500 dark:text-muted-300">Email для: </span><span class="text-muted-900 dark:text-white">{{ replyTo.join(', ') }}</span>
                    </summary>
                    <div class="text-sm max-h-[70vh] overflow-y-auto">
                        <ul class="border-b border-b-muted-200 dark:border-b-muted-700">
                            <li class="p-2.5 text-sm flex flex-wrap items-center gap-3">
                                <span>
                                    <span class="text-muted-500 dark:text-muted-300">Email для: </span><span class="text-muted-900 dark:text-white">{{ replyTo.join(', ') }}</span>
                                </span>
                                <input v-for="address of replyTo" :key="address" type="hidden" name="to[]" :value="address">
                                <BaseCheckbox v-if="ccAll.length" v-model="replyAll" label="Ответить всем" rounded="sm" color="primary" />
                            </li>
                            <li class="flex items-center space-x-2 px-2.5 border-t border-t-muted-200 dark:border-t-muted-700">
                                <label class="text-muted-500 dark:text-muted-300" for="cc">Копия: </label>
                                <input id="cc" v-model="cc" class="outline-none py-2 text-muted-900 w-full bg-transparent dark:text-white" name="cc[]" placeholder="адреса через запятую" />
                            </li>
                            <li class="flex items-center space-x-2 px-2.5 border-t border-t-muted-200 dark:border-t-muted-700">
                                <label class="text-muted-500 dark:text-muted-300" for="subject">Тема: </label>
                                <input id="subject" class="outline-none py-2 text-muted-900 w-full bg-transparent dark:text-white" v-model="emailSubject" name="subject" />
                            </li>
                            <li class="flex items-center px-2.5 border-t border-t-muted-200 dark:border-t-muted-700">
                                <label class="text-muted-500 dark:text-muted-300" for="transporter">От: </label>
                                <select id="transporter" v-model="transporterId" class="p-2 outline-none text-muted-900 appearance-none w-full bg-transparent dark:text-white dark:bg-muted-800" name="transporter_id">
                                    <option v-for="transporter in transporters" :value="String(transporter.id)">
                                        {{ transporter.email }}
                                    </option>
                                    <option value="">Общий ящик компании</option>
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
                        <div class="px-2.5 py-2 border-t border-t-muted-200 dark:border-t-muted-700">
                            <BaseCheckbox v-model="withQuote" label="Процитировать письмо под ответом" rounded="sm" color="primary" />
                        </div>
                        <SignaturePreview v-model="withSignature" />
                        <MailAssistant
                            v-model:body="emailBody"
                            v-model:subject="emailSubject"
                            :deal-id="selectedDeal?.id ?? email.deals?.[0]?.id"
                            :reply-to-email-id="email.id"
                        />
                        <div class="flex gap-2">
                            <BaseButton color="primary" type="submit" class="ml-2.5" :disabled="sending">Отправить</BaseButton>
                            <BaseButton variant="pastel" @click="toggleEditor">Отменить</BaseButton>
                        </div>
                    </div>
                </details>
            </form>
        </section>
    </section>
</template>

<script lang="ts" setup>
import { useRoute } from 'vue-router';

import type BaseHeading from '~/components/base/BaseHeading.vue';
import Editor from '~/components/common/Editor.vue';
import MailAssistant from '~/components/mail/MailAssistant.vue';
import SignaturePreview from '~/components/mail/SignaturePreview.vue';
import { useAsync } from '~/composables/useAsync';
import type { Deal } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';
import type { Email, Template, Transporter } from '~/types/mail';
import { letterView, replySubject } from '~/utils/mailView';
import { sanitizeEmail } from '~/utils/sanitize';

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

const emits = defineEmits<{
    (e: 'changed', id: number): void;
}>();

type Reply = { to: string[]; cc_all: string[] };

const route = useRoute();
const mailService = useService('emails', {auth: true});
const templateService = useService('emails/templates', {auth: true});
const transporterService = useService('emails/transporters', {auth: true});
const dealService = useService('deals', {auth: true});
const contactService = useService('contacts', {auth: true});

const toast = useToast('GlobalToast');
const { data: email, run } = useAsync<Email & { reply?: Reply }>(props.email ? props.email : {to: [], cc: []});
// cleaned here: a letter opened by its address does not come through the list
const sanitized = computed(() => sanitizeEmail({ body: email.value?.body }));
// the letter for reading: HTML (cleaned) or text, its own part and the quoted earlier letters
const view = computed(() => letterView(email.value));
const showQuote = ref(false);
const { data: templates, isLoading: templatesLoading, run: runTemplates } = useAsync<Template[]>([]);
const { data: deals, run: runDeals } = useAsync<PaginatedResponse<Deal>>({
    data: [],
});
const { data: transporters, run: runTransporters } = useAsync<Transporter[]>([]);
const { runAsync, isLoading: sending } = useAsync();

const emailSubject = ref();
const emailBody = ref<string>('');
const detailsRef = ref();
const choosingDeal = ref(false);
// The deal picked in «Привязать»: the letter goes into its history (and the reply too)
const selectedDeal = ref<Deal>();
const selectedContact = ref<{ id: number; username: string }>();
const contacts = ref<any[]>([]);
const linkBusy = ref(false);
const lastTemplate = ref<Template>();
// "" = the shared mailbox; the user's own mailbox when there is one, as before
const transporterId = ref('');
const replyAll = ref(false);
const cc = ref('');
const withQuote = ref(true);
const withSignature = ref(true);

/** The sender, or for a letter we sent its recipients (the server works it out, our own addresses left out). */
const replyTo = computed<string[]>(() => {
    const fromServer = email.value?.reply?.to;
    if (fromServer?.length) return fromServer;
    return email.value?.from ? [email.value.from] : [];
});
const ccAll = computed<string[]>(() => email.value?.reply?.cc_all ?? []);

watch(replyAll, (all) => {
    const current = cc.value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    cc.value = all
        ? [...new Set([...current, ...ccAll.value])].join(', ')
        : current.filter((address) => !ccAll.value.includes(address.toLowerCase())).join(', ');
});

async function onSend(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    if (!String(formData.get('cc[]') ?? '').trim()) formData.delete('cc[]');
    if (!formData.get('transporter_id')) formData.delete('transporter_id');
    formData.append('body', emailBody.value);
    formData.append('reply_to_email_id', String(email.value.id));
    formData.append('quote', withQuote.value ? 'true' : 'false');
    formData.append('with_signature', withSignature.value ? 'true' : 'false');
    if (selectedDeal.value?.id) formData.append('deal_id', String(selectedDeal.value.id));
    const result = await promiseResult(runAsync(mailService.create(formData).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 5000});
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

const onContactInput = debounce(async (e: Event) => {
    const text = (e.target as HTMLInputElement).value?.trim();
    const result = await promiseResult(contactService.find({ q: text, role: 'ctr_agent', limit: 20 }).exec());
    if (result.ok) contacts.value = (result.value as any)?.data ?? [];
}, 300);

/** The client's address of the letter: its sender (a letter we sent: the first recipient). */
const counterpart = computed(() => email.value?.outgoing ? (email.value?.to?.[0]?.value ?? '') : (email.value?.from ?? ''));

/** «Привязать»: the letter into the chosen deal and / or its sender to the chosen contact. */
async function onLink() {
    if (!selectedDeal.value && !selectedContact.value) return;
    linkBusy.value = true;
    const result = await promiseResult(mailService.post(`${email.value.id}/link`, {
        ...(selectedDeal.value?.id ? { deal_id: selectedDeal.value.id } : {}),
        ...(selectedContact.value?.id ? { contact_id: selectedContact.value.id } : {}),
    }).exec());
    linkBusy.value = false;
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 5000});
    const linked = result.value as { deal?: { display_id: number; label: string } | null; contact?: { username: string } | null; letters?: number };
    const parts = [
        linked?.deal ? `в сделку №${linked.deal.display_id} ${linked.deal.label}` : '',
        linked?.contact ? `к контакту ${linked.contact.username}` : '',
    ].filter(Boolean);
    toast.show({message: `Письмо привязано ${parts.join(' и ')}`, type: 'success', timeout: 4000});
    choosingDeal.value = false;
    selectedContact.value = undefined;
    run(mailService.get(email.value.id).exec());
    emits('linked', email.value.id);
}

function toggleEditor() {
    detailsRef.value.removeAttribute('open');
}

async function markAsSpam() {
    const result = await promiseResult(mailService.patch(`${email.value.id}/mark-as-spam`, '').exec());
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    email.value.is_spam = true;
    emits('changed', email.value.id);
}

async function markAsNotSpam() {
    const result = await promiseResult(mailService.patch(`${email.value.id}/not-spam`, {}).exec());
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    email.value.is_spam = false;
    toast.show({message: 'Письмо перенесено во «Входящие»', type: 'success', timeout: 3000});
    emits('changed', email.value.id);
}

async function restore() {
    const result = await promiseResult(mailService.patch(`${email.value.id}/restore`, {}).exec());
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    email.value.deleted_at = null;
    toast.show({message: 'Письмо восстановлено', type: 'success', timeout: 3000});
    emits('changed', email.value.id);
}

watchEffect(() => {
    if (email.value?.subject) emailSubject.value = replySubject(email.value.subject);
});

watch(transporters, (list) => {
    if (list?.length && transporterId.value === '') transporterId.value = String(list[0].id);
});

watchEffect(() => {
    if (choosingDeal.value && !deals.value.data.length) runDeals(dealService.find().exec());
});

onMounted(() => {
    // the whole letter (its HTML part, deals, client, whom to reply): the list carries only the short form
    const id = props.email?.id ?? route.params.id;
    if (id) {
        run(mailService.get(id as string).exec());
    }
    runTemplates(templateService.find().exec());
    runTransporters(transporterService.find().exec());
});

</script>

<style>
/* letters as HTML: tables of price lists and specifications stay tables */
.mail-html table {
    border-collapse: collapse;
    max-width: 100%;
}
.mail-html td,
.mail-html th {
    border: 1px solid rgb(203 213 225);
    padding: 2px 6px;
    vertical-align: top;
}
.mail-html p {
    margin: 0 0 0.5rem;
}
.mail-html img {
    max-width: 100%;
    height: auto;
}
.mail-html a {
    color: rgb(13 148 136);
    text-decoration: underline;
}
.mail-html blockquote {
    border-left: 2px solid rgb(203 213 225);
    padding-left: 0.75rem;
    margin: 0.5rem 0;
}
</style>
