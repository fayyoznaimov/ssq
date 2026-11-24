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
                <!-- «Кому» and «Копия»: an address typed by hand, or a contact / company of the CRM from the hints -->
                <template v-for="key of recipientKeys" :key="key">
                    <form @submit.prevent="onRecepientSubmit(key)">
                        <BaseInput
                            v-model="typed[key]"
                            :label="key === 'to' ? 'Кому *' : 'Копия'"
                            type="text"
                            :icon="key === 'to' ? 'ph:envelope-simple' : 'ph:at'"
                            name="email"
                            placeholder="Имя контакта, компания или адрес"
                            :required="key === 'to' && recepients.to.length < 1"
                            autocomplete="off"
                            @input="() => onTyping(key)"
                            @focus="() => activeField = key"
                        />
                        <p class="mt-1 text-xs text-muted-500 dark:text-muted-400">Несколько адресов — через запятую или по Enter</p>
                    </form>
                    <ul
                        v-if="activeField === key && hints.length"
                        class="-mt-2 flex flex-col divide-y divide-muted-200 rounded-md border border-muted-200 bg-white text-sm dark:divide-muted-700 dark:border-muted-700 dark:bg-muted-800"
                    >
                        <li v-for="hint of hints" :key="hint.kind + hint.id + hint.email">
                            <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted-50 dark:hover:bg-muted-900" @click="() => addHint(key, hint)">
                                <Icon :name="hint.kind === 'company' ? 'ph:buildings' : 'ph:user'" class="size-4 shrink-0 text-muted-400" />
                                <span class="min-w-0 flex-1 truncate">
                                    <span class="text-muted-900 dark:text-white">{{ hint.name }}</span>
                                    <span class="text-muted-500 dark:text-muted-400"> · {{ hint.email }}</span>
                                </span>
                            </button>
                        </li>
                    </ul>
                    <div v-if="recepients[key].length" class="flex flex-wrap gap-2">
                        <template v-for="(email, i) in recepients[key]" :key="email">
                            <BaseSnack size="sm" @delete="() => recepients[key].splice(i, 1)">{{ email }}</BaseSnack>
                            <input type="hidden" :name="key + '[]'" :value="email" form="email-form" />
                        </template>
                    </div>
                </template>
                <BaseInput label="Тема" name="subject" v-model="emailSubject" form="email-form" />
                <!-- the deal the letter is written from: it goes into its history and no other -->
                <BaseAutocomplete
                    v-model="selectedDeal"
                    label="Сделка"
                    placeholder="Название или номер сделки (необязательно)"
                    :fixed="true"
                    :items="deals"
                    :properties="{label: 'label', value: 'id', sublabel: (deal: Deal) => `№${deal.display_id ?? deal.id}`}"
                    :display-value="(deal: Deal) => deal?.label ? `№${deal.display_id ?? deal.id} ${deal.label}` : ''"
                    dropdown
                    clearable
                    @input="onDealInput"
                />
                <BaseSelect v-if="templates.length" label="Шаблон" v-model="template" placeholder="Выберите шаблон" :loading="templatesLoading" form="email-form">
                    <option v-for="template of templates" :value="template.id">{{ template.name }}</option>
                </BaseSelect>
                <div class="bg-white dark:bg-transparent text-sm rounded-md border border-muted-300 dark:border-muted-700 pb-2">
                    <Editor v-model="emailBody" form="email-form" />
                    <SignaturePreview v-model="withSignature" />
                    <MailAssistant v-model:body="emailBody" v-model:subject="emailSubject" :deal-id="selectedDeal?.id" />
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
import type { Deal } from '~/types/deal';
import type { Template, Transporter } from '~/types/mail';
import { promiseResult } from '~/utils/result';
import { debounce } from '~/utils/search';

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Новое письмо',
    subject: 'Mail'
});

useHead({
    title: 'Новое письмо'
});

type Key = 'to' | 'cc';
type Hint = { kind: 'contact' | 'company'; id: number; name: string; email: string };

const route = useRoute();
// "" = the shared mailbox of the company; the user's own mailbox when there is one
const transporterId = ref('');
const recipientKeys: Key[] = ['to', 'cc'];
const mailService = useService('emails', {auth: true});
const transporterService = useService('emails/transporters', {auth: true});
const templateService = useService('emails/templates', {auth: true});
const contactService = useService('contacts', {auth: true});
const companyService = useService('companies', {auth: true});
const dealService = useService('deals', {auth: true});
const toast = useToast('GlobalToast');
const emailBody = ref('');
const emailSubject = ref('');
const template = ref();
// the server adds the signature under the text (in the editor it lost its formatting)
const withSignature = ref(true);
const recepients = reactive<{cc: string[], to: string[]}>({cc: [], to: []});
const typed = reactive<{cc: string, to: string}>({cc: '', to: ''});
const activeField = ref<Key | null>(null);
const hints = ref<Hint[]>([]);
const deals = ref<Deal[]>([]);
const selectedDeal = ref<Deal>();
const { runAsync, isLoading } = useAsync();
const { run, data: transporters, isLoading: transportersLoading } = useAsync<Transporter[]>([]);
const { data: templates, isLoading: templatesLoading, run: runTemplates } = useAsync<Template[]>([]);

/** "a@b.uz, c@d.uz; e@f.uz" -> three addresses */
function splitAddresses(value: unknown): string[] {
    return String(value ?? '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function addAddresses(key: Key, value: unknown) {
    for (const email of splitAddresses(value)) {
        if (!recepients[key].includes(email)) recepients[key].push(email);
    }
}

function onRecepientSubmit(key: Key) {
    addAddresses(key, typed[key]);
    typed[key] = '';
    hints.value = [];
}

function addHint(key: Key, hint: Hint) {
    addAddresses(key, hint.email);
    typed[key] = '';
    hints.value = [];
}

/** Contacts and companies of the CRM with an e-mail, by the words typed (a typed address with "@" is not searched). */
const searchHints = debounce(async (text: string) => {
    if (text.length < 2 || text.includes('@') || text.includes(',')) {
        hints.value = [];
        return;
    }
    const [people, companies] = await Promise.all([
        promiseResult(contactService.find({ q: text, role: 'ctr_agent', limit: 8 }).exec()),
        promiseResult(companyService.find({ q: text, limit: 8 }).exec()),
    ]);
    const found: Hint[] = [];
    for (const contact of (people.ok ? (people.value as any)?.data : []) ?? []) {
        if (contact?.email) found.push({ kind: 'contact', id: contact.id, name: [contact.username, contact.company?.name].filter(Boolean).join(' · '), email: contact.email });
    }
    for (const company of (companies.ok ? (companies.value as any)?.data : []) ?? []) {
        if (company?.email) found.push({ kind: 'company', id: company.id, name: company.name, email: company.email });
    }
    hints.value = found.slice(0, 10);
}, 300);

function onTyping(key: Key) {
    activeField.value = key;
    // a comma ends an address, as Enter does
    if (/[,;]\s*$/.test(typed[key])) {
        onRecepientSubmit(key);
        return;
    }
    searchHints(typed[key].trim());
}

const onDealInput = debounce(async (e: Event) => {
    const text = (e.target as HTMLInputElement).value?.trim();
    const result = await promiseResult(dealService.find({ label: text, limit: 20 }).exec());
    if (result.ok) deals.value = (result.value as any)?.data ?? [];
}, 300);

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
    // what is typed but not yet added with Enter goes too
    addAddresses('to', typed.to);
    addAddresses('cc', typed.cc);
    typed.to = '';
    typed.cc = '';
    if (!recepients.to.length) {
        return toast.show({message: 'Укажите адрес получателя', type: 'error', timeout: 4000});
    }

    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    formData.delete('to[]');
    formData.delete('cc[]');
    for (const address of recepients.to) formData.append('to[]', address);
    for (const address of recepients.cc) formData.append('cc[]', address);
    if (!formData.get('transporter_id')) formData.delete('transporter_id');
    if (selectedDeal.value?.id) formData.append('deal_id', String(selectedDeal.value.id));

    formData.append('body', emailBody.value ?? '');
    formData.append('with_signature', withSignature.value ? 'true' : 'false');

    const result = await promiseResult(runAsync(mailService.create(formData).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 5000});
    toast.show({message: 'Письмо отправлено', type: 'success', timeout: 3000});
    navigateTo(selectedDeal.value?.id && route.query.deal ? `/deals/${selectedDeal.value.id}` : '/mails');
}

onMounted(async () => {
    run(transporterService.find().exec());
    runTemplates(templateService.find().exec());
    // /mails/new?to=a@b.uz&deal=12&subject=…: the form opened from a deal or a client card
    if (route.query.to) addAddresses('to', route.query.to);
    if (route.query.subject) emailSubject.value = String(route.query.subject);
    const dealId = Number(route.query.deal);
    if (dealId) {
        const result = await promiseResult(dealService.get(dealId).exec());
        if (result.ok && result.value) {
            selectedDeal.value = result.value as Deal;
            deals.value = [result.value as Deal];
        }
    }
});

</script>
