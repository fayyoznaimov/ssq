<template>
    <div ref="rootRef" class="flex flex-col">
        <form id="deal-form" @submit.prevent="onSubmit" novalidate></form>
        <!-- every field is in the flow: the column (single.vue) or the page scrolls, nothing is hidden
             in an inner box without a scrollbar -->
        <div class="flex flex-col space-y-6 px-2">
            <section>
                <div class="flex flex-col space-y-4 mt-2">
                    <BaseInput
                        form="deal-form"
                        name="label"
                        label="Название сделки"
                        placeholder="Например: полотенца для отеля"
                        v-model="deal.label"
                        maxlength="255"
                    />
                    <BaseListbox
                        form="deal-form"
                        name="stage"
                        v-model="deal.stage"
                        :items="sortedStages"
                        label="Этап"
                        :loading="stagesLoading"
                        :properties="{ value: 'id', label: 'name' }"
                    />
                    <BaseInput
                        form="deal-form"
                        name="budget"
                        label="Бюджет"
                        inputmode="decimal"
                        v-model="deal.budget"
                        @input="(e: Event) => onChange('budget', (e.target as HTMLInputElement).value)"
                        :error="errors.budget"
                    />
                    <BaseAutocomplete
                        v-if="user.role === 'admin'"
                        v-model="deal.agent"
                        name="agent"
                        form="deal-form"
                        :items="users.data"
                        :display-value="(user: User) => user?.username"
                        :properties="{
                            value: 'id',
                            label: 'username',
                            sublabel: (item: User) => item.group?.name,
                        }"
                        label="Ответственный"
                        @input="onAgentInput"
                        dropdown
                        @change="(c: Company) => onChange('agent', c?.id)"
                        :error="errors.agent"
                        required
                    />
                    <template v-else>
                        <input type="hidden" form="deal-form" name="agent[id]" v-model="deal.agent.id">
                        <BaseInput label="Ответственный" form="deal-form" name="agent" v-model="deal.agent.username" readonly />
                    </template>
                    <ul class="flex flex-col">
                        <li class="flex items-end gap-2" v-for="(filler, idx) in deal.deal_fillers">
                            <input form="deal-form" type="hidden" name="fillers" :value="filler.id">
                            <input v-if="filler.new" type="hidden" :name="`fillers.${filler.id}.${idx}.new`" value="new" form="deal-form" />
                            <input type="hidden" :name="`fillers.${filler.id}.${idx}.tempId`" :value="filler.filler.id" form="deal-form">
                            <BaseInput
                                :classes="{wrapper: 'w-full'}"
                                form="deal-form"
                                :label="filler.filler.field"
                                v-model="filler.value"
                                :name="`fillers.${filler.id}.${idx}`"
                                :required="filler.filler.is_required"
                                :error="errors[filler.filler.id]"
                                :key="filler.id"
                                @input="(e: Event) => onChange(String(filler.filler.id), (e.target as HTMLInputElement).value)"
                            >
                                <template #action>
                                    <BaseButtonIcon v-if="false" rounded="md">
                                        <Icon name="ph:plus" class="size-4" />
                                    </BaseButtonIcon>
                                </template>
                            </BaseInput>
                        </li>
                    </ul>
                </div>
            </section>
            <Contacts
                :contacts="contacts.data"
                :contacts-loading="contactsLoading"
                :fillers="fillers.user || []"
                :deal="deal"
            />
            <Products :deal="deal" />
            <section>
                <h3 class="block text-sm font-medium text-muted-900 dark:text-muted-100">Компания</h3>
                <CompanyAutocomplete
                    :contacts="contacts.data"
                    :contacts-loading="contactsLoading"
                    v-model="deal.company"
                    @changed="onCompanyChanged"
                    name="company"
                    form="deal-form"
                    :error="errors.company"
                    label="Название"
                    class="mt-1"
                />
                <BaseInput
                    v-model="deal.company.email"
                    name="company[email]"
                    label="Электронная почта"
                    form="deal-form"
                    @input="(e: Event) => onChange('companyEmail', (e.target as HTMLInputElement).value)"
                    :error="errors.companyEmail"
                />
                <BaseInput
                    v-model="deal.company.phone"
                    name="company[phone]"
                    label="Номер телефона"
                    form="deal-form"
                    @input="(e: Event) => onChange('companyPhone', (e.target as HTMLInputElement).value)"
                    :error="errors.companyPhone"
                />
                <ul class="flex flex-col">
                    <li class="flex items-end gap-2" v-for="(filler, idx) in deal.company?.company_fillers">
                        <input type="hidden" name="company_fillers" :value="filler.id" form="deal-form">
                        <input type="hidden" :name="`company_fillers.${filler.id}.${idx}.tempId`" :value="filler.filler.id" form="deal-form">
                        <input v-if="filler.new" type="hidden" :name="`company_fillers.${filler.id}.${idx}.new`" value="new" form="deal-form">
                        <BaseInput
                            :classes="{wrapper: 'w-full'}"
                            :label="filler.filler.field"
                            v-model="filler.value"
                            :name="`company_fillers.${filler.id}.${idx}`"
                            form="deal-form"
                            :required="companyFillerRequired(filler.filler.id)"
                            :error="errors[filler.filler.id]"
                            :key="filler.id"
                            @input="(e: Event) => onChange(String(filler.filler.id), (e.target as HTMLInputElement).value)"
                        >
                            <template #action>
                                <BaseButtonIcon v-if="false" class="hidden" rounded="md" @click="() => deal.company.company_fillers.splice(idx + 1, 0, {...filler, id: filler.filler.id, value: '', new: true})">
                                    <Icon name="ph:plus" class="size-4" />
                                </BaseButtonIcon>
                            </template>
                        </BaseInput>
                    </li>
                </ul>
            </section>
        </div>
        <!-- always at hand: stuck to the bottom of the column (PC) or of the screen (phone) -->
        <div class="sticky bottom-0 z-10 mt-4 py-3 px-2 flex space-x-2 bg-muted-100/95 dark:bg-muted-900/95 border-t border-muted-200 dark:border-muted-700">
            <NuxtLink :to="route.query.from">
                <BaseButton type="button" :disabled="upsertingDeal">
                    Отменить
                </BaseButton>
            </NuxtLink>
            <!-- a saved deal: the right to change it (its responsible user decides at "own" / "group");
                 a new one: the right to create deals -->
            <Can :I="deal.id ? 'update' : 'create'" :this="deal.id ? subject('Deal', deal) : 'Deal'">
                <BaseButton color="primary" type="submit" form="deal-form" :disabled="upsertingDeal">
                    Сохранить
                </BaseButton>
            </Can>
        </div>
    </div>
</template>
<script lang="ts" setup>
import { subject } from '@casl/ability';
import { Can } from '@casl/vue';

import type BaseButtonIcon from '~/components/base/BaseButtonIcon.vue';
import BaseInput from '~/components/form/BaseInput.vue';
import { useAppAbility } from '~/composables/useAppAbility';
import { useValidation } from '~/composables/useValidation';
import { invalidFieldsMessage, revealFirstError } from '~/utils/formErrors';
import type { Deal } from '~/types/deal';
import type { Stage } from '~/types/stage';
import type { Filler } from '~/types/filler';
import type { Company, CompanyContact, Contact, User } from '~/types/user';
import { promiseResult } from '~/utils/result';
import { debounce } from '~/utils/search';
import { optional, required, type Schema, validEmail, validPhone, when } from '~/utils/validation';

import CompanyAutocomplete from './company-autocomplete.vue';
import Contacts from './contacts.vue';
import Products from './products.vue';

const props = defineProps<{
    deal: Deal,
    stages: Stage[],
    user: User,
    users: User[];
    stagesLoading: boolean,
    fillers: { company: Filler[], deal: Filler[], user: Filler[], product: Filler[] }
}>();

const emits = defineEmits<{
    (e: 'created', deal: Deal): void,
    (e: 'updated', deal: Deal): void,
}>();

const ability = useAppAbility();
const userService = useService('users', { auth: true });
const companyService  = useService('companies', { auth: true });
const contactService  = useService('contacts', { auth: true });
const stagesService  = useService('stages', { auth: true });
const dealService = useService('deals', { auth: true });

const { run: runContacts, isLoading: contactsLoading, data: contacts } = useAsync<{data: Contact[], count: number}>({ data: [], count: 0 });
const { run: runUsers, data: users } = useAsync<{data: User[], count: number}>({ data: props.users, count: 0 });
const { runAsync: runDealAsync, isLoading: upsertingDeal } = useAsync();
// the stage the API gives a deal without one (GET /stages/default): preselected for a new deal
const { run: runDefaultStage, data: defaultStage } = useAsync<Stage | null>(null);

const route = useRoute();
const sortedStages = computed(() => props.stages.sort((a, b) => a.order - b.order));
const toast = useToast('GlobalToast');
const deal = computed(() => props.deal);

type Check = { ok: true, value: undefined } | { ok: false, error: string };
const passed: Check = { ok: true, value: undefined };

// a sum of money, cents allowed: «1 500 000», «1250,50», «1250.5»
function moneySum(message: string) {
    return (value: unknown): Check => /^\d+([.,]\d{1,2})?$/.test(String(value ?? '').replace(/\s/g, '')) ? passed : { ok: false, error: message };
}

function atLeast(length: number, message: string) {
    return (value: unknown): Check => String(value ?? '').trim().length >= length ? passed : { ok: false, error: message };
}

// «1 500 000,5» -> 1500000.5 (the API keeps numeric(18,2))
const toNumber = (value: unknown) => Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
const roundTo = (value: number, digits: number) => Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
const toSum = (value: unknown) => roundTo(toNumber(value), 2);

// Required is only what the API requires: the responsible and the required fields of the deal.
// The company, its e-mail and phone are optional (clients from Telegram, WhatsApp and calls often
// have none). The required fields of a company: for a new company and for a value it already has.
const schema: Schema<string> = {
    budget: [optional(moneySum('Бюджет — число, копейки через запятую (не больше 2 знаков)'))],
    agent: [required('Обязательное поле')],
    company: [optional(atLeast(3, 'Название компании — от 3 символов'))],
    companyEmail: [optional(validEmail('Неверный формат почты'))],
    companyPhone: [optional(validPhone('Неверный номер телефона'))],
};

const { validate, onChange, errors } = useValidation(schema);

const rootRef = ref<HTMLElement>();

const trim = (value: unknown) => String(value ?? '').trim();

// The company of the deal as it was loaded (trimmed values; extra fields by filler id).
// Saving the deal patches the company only when the form changed something of it,
// and keeps the company's own «Старый клиент».
type CompanySnapshot = {
    id: number;
    name: string;
    email: string;
    phone: string;
    is_old: boolean;
    fillers: Record<string, string>;
};
const companySnapshot = ref<CompanySnapshot | null>(null);
const snapshot = computed(() => {
    const s = companySnapshot.value;
    return s && s.id === Number(deal.value.company?.id) ? s : null;
});
// the company the deal has on the server: clearing the field takes it off the deal
let savedCompanyId: number | null = null;

// a company typed in the form and not created yet
const isNewCompany = computed(() => {
    const company: any = deal.value.company;
    return !!company && !Array.isArray(company) && !company.id && !!trim(company.name);
});

// a required extra field of companies: a new company needs it, an existing one cannot lose its value
function companyFillerRequired(fillerId: number | string): boolean {
    const filler = (props.fillers.company || []).find((f) => String(f.id) === String(fillerId));
    if (!filler?.is_required) return false;
    if (isNewCompany.value) return true;
    return !!snapshot.value?.fillers[String(fillerId)];
}

function newFiller(filler: Filler) {
    return {
        id: filler.id,
        value: '',
        filler,
        new: true,
        created_at: new Date().toISOString(),
        tempId: Math.random().toString(32).slice(2),
    };
}

// the company field is {} when empty (the autocomplete clears it to [] or null)
function normalizeCompany() {
    const company: any = deal.value.company;
    if (!company || Array.isArray(company)) deal.value.company = {} as any;
}

// every extra field of companies is in the form: the company's value or an empty new one
function ensureCompanyFillers() {
    normalizeCompany();
    if (!deal.value.company.company_fillers) deal.value.company.company_fillers = [];
    for (const filler of props.fillers.company || []) {
        if (deal.value.company.company_fillers.some((cf) => cf.filler?.id === filler.id)) continue;
        deal.value.company.company_fillers.push(newFiller(filler));
    }
}

// `own`: the company's own e-mail, phone and «Старый клиент» from GET /companies/:id
function takeSnapshot(own?: { email: string; phone: string; is_old: boolean }) {
    const company = deal.value.company;
    if (!company?.id) {
        companySnapshot.value = null;
        return;
    }
    const fillers: Record<string, string> = {};
    for (const cf of company.company_fillers || []) {
        if (cf.filler?.id && !cf.new && trim(cf.value)) fillers[String(cf.filler.id)] = trim(cf.value);
    }
    companySnapshot.value = {
        id: Number(company.id),
        name: trim(company.name),
        email: trim(own ? own.email : company.email),
        phone: trim(own ? own.phone : company.phone),
        is_old: !!(own ? own.is_old : company.is_old),
        fillers,
    };
}

// The contacts as the form got them: a contact is saved only when its block was changed
// (an untouched contact from Telegram without e-mail or company does not stop the deal from saving)
const contactSnapshots = new Map<number, string>();

function contactKey(agent: any): string {
    return JSON.stringify({
        username: trim(agent.username),
        email: trim(agent.email),
        phone: trim(agent.phone),
        company: agent.company?.id ?? null,
        fillers: (agent.user_fillers || [])
            .filter((uf: any) => trim(uf.value))
            .map((uf: any) => `${uf.filler?.id}:${trim(uf.value)}`)
            .sort(),
    });
}

function snapshotNewContacts() {
    for (const agent of deal.value.ctr_agents || []) {
        if (!contactSnapshots.has(agent.id)) contactSnapshots.set(agent.id, contactKey(agent));
    }
}

watch(() => (deal.value.ctr_agents || []).map((agent) => agent.id).join(','), snapshotNewContacts);

// the extra fields of the deal and of its contacts that have no value yet: empty new ones
function addFillerPlaceholders() {
    for (const filler of props.fillers.deal || []) {
        if (filler.is_required) schema[filler.id] = [required('Обязательное поле')];
        if (deal.value.deal_fillers.some((df) => df.filler.id === filler.id)) continue;
        deal.value.deal_fillers.push(newFiller(filler));
    }

    ensureCompanyFillers();
    for (const filler of props.fillers.company || []) {
        if (filler.is_required) schema[filler.id] = [when(() => companyFillerRequired(filler.id), required('Обязательное поле'))];
    }

    // the fields of the contacts are checked by their own forms (contacts.vue), not by this schema
    for (const filler of props.fillers.user || []) {
        for (const agent of deal.value.ctr_agents) {
            if (!agent.user_fillers) agent.user_fillers = [];
            if (agent.user_fillers.some((uf) => uf.filler.id === filler.id)) continue;
            agent.user_fillers.push(newFiller(filler));
        }
    }
}

// The deal is loaded (or loaded again after a save): the form starts from what the server has
watch(() => props.deal, () => {
    contactSnapshots.clear();
    companySnapshot.value = null;
    savedCompanyId = deal.value.id && deal.value.company?.id ? Number(deal.value.company.id) : null;
    addFillerPlaceholders();
    takeSnapshot();
    snapshotNewContacts();
}, { immediate: true });

watch(() => props.fillers, () => {
    addFillerPlaceholders();
    // the placeholders are not values: the snapshots stay comparable
    if (!companySnapshot.value) takeSnapshot();
});

// the form did not pass the checks: the toast names the fields, the first one is shown
function showInvalid(errors: Record<string, string>) {
    const labels: Record<string, string> = {
        budget: 'Бюджет',
        agent: 'Ответственный',
        company: 'Компания',
        companyEmail: 'Электронная почта компании',
        companyPhone: 'Телефон компании',
    };
    for (const filler of [...(props.fillers.deal || []), ...(props.fillers.company || [])]) labels[String(filler.id)] = filler.field;
    toast.show({message: invalidFieldsMessage(errors, labels), timeout: 5000, type: 'error'});
    revealFirstError(rootRef.value);
}

const onAgentInput = debounce((e: Event) => {
    const target = (e.target as HTMLInputElement);
    runUsers(userService.find({ username: target.value }).exec());
}, 500);

async function onCompanyChanged(contact: CompanyContact) {
    const picked: any = contact;
    // the field was cleared: the deal has no company
    if (!picked || Array.isArray(picked) || (!picked.id && !trim(picked.name))) {
        normalizeCompany();
        companySnapshot.value = null;
        onChange('company', '');
        return;
    }
    onChange('company', picked.name);
    if (!picked.id) {
        // a new name: the company is created when the deal is saved, with the fields filled here
        companySnapshot.value = null;
        normalizeCompany();
        deal.value.company.company_fillers = [];
        ensureCompanyFillers();
        return;
    }
    const result = await promiseResult(companyService.get<any>(picked.id).exec());
    if (!result.ok) return toast.show({message: 'Не удалось загрузить компанию: ' + result.error.message, timeout: 4000, type: 'error'});
    const company = result.value;
    // another company was picked while this one was loading
    if (Number(deal.value.company?.id) !== Number(picked.id)) return;
    // GET /companies/:id gives the values of the extra fields as `fillers`: { id, filler_id, value }
    const values = company.fillers ?? company.company_fillers ?? [];
    const definitions = props.fillers.company || [];
    deal.value.company.company_fillers = values
        .map((cf: any) => ({ ...cf, filler: cf.filler ?? definitions.find((f) => f.id === cf.filler_id) }))
        .filter((cf: any) => cf.filler);
    // the phone and e-mail shown from the primary contact are not the company's own
    const own = {
        email: company.email_from_contact ? '' : company.email,
        phone: company.phone_from_contact ? '' : company.phone,
        is_old: !!company.is_old,
    };
    deal.value.company.email = own.email;
    deal.value.company.phone = own.phone;
    deal.value.company.is_old = own.is_old;
    takeSnapshot(own);
    ensureCompanyFillers();
    onChange('companyEmail', own.email);
    onChange('companyPhone', own.phone);
    for (const cf of deal.value.company.company_fillers) onChange(String(cf.filler.id), cf.value);
}

async function onSubmit(e: Event) {
    if (deal.value.id) await onEdit(e);
    else await onCreate(e);
}

/**
 * The company of the form: created when it is new, patched only when the form changed it.
 * Returns its id, or null when the form has no company.
 */
async function upsertCompany({id, email, phone, name, fillers, fillersCreate, values}: {
    id: string;
    email: string;
    name: string;
    phone: string;
    fillers: {
        company_filler_id: number;
        value: string;
    }[];
    fillersCreate: {
        filler_id: number;
        value: string;
    }[];
    // the company's extra fields in the form, by filler id
    values: Record<string, string>;
}): Promise<number | null> {
    if (id) {
        const snap = companySnapshot.value;
        if (snap && snap.id === Number(id)) {
            const current = Object.fromEntries(
                Object.entries(values).map(([key, value]) => [key, trim(value)]).filter(([, value]) => value),
            );
            const unchanged = snap.name === trim(name) && snap.email === trim(email) && snap.phone === trim(phone)
                && Object.keys({...snap.fillers, ...current}).every((key) => (snap.fillers[key] ?? '') === (current[key] ?? ''));
            // nothing of the company was changed here: it is not saved, its history gets no false changes
            if (unchanged) return Number(id);
        }
        await companyService.patch(id as string, {
            name: trim(name),
            // an emptied field is cleared; an unchanged one is sent as it is (no false change in the history)
            email: trim(email) || null,
            phone: trim(phone) || null,
            // the API takes an existing value by `id`
            fillers: fillers.map((f) => ({ id: f.company_filler_id, ...f })),
            fillers_create: fillersCreate,
            // «Старый клиент» is not in this form and is not sent: the company keeps its own
        }).exec();
        return Number(id);
    }

    if (!trim(name)) return null;

    const created = await companyService.create<Company>({
        email: trim(email) || undefined,
        name: trim(name),
        phone: trim(phone) || undefined,
        fillers: fillersCreate,
        users: [],
        is_old: false,
    }).exec();
    if (created?.id) return created.id;

    const found = await companyService.find<{data: Company[]}>({ name: trim(name) }).exec();
    const company = found.data.find((c) => c.name === trim(name));
    if (!company) throw new Error('Не удалось создать компанию');
    return company.id;
}

/** The contact's block of the form, saved only when it was changed. Returns false when untouched. */
async function updateAgent(agent: User): Promise<boolean> {
    if (contactSnapshots.get(agent.id) === contactKey(agent)) return false;
    const company: any = agent.company;
    if (company && !Array.isArray(company) && !company.id && trim(company.name)) {
        throw new Error(`компании «${trim(company.name)}» ещё нет: выберите компанию из списка`);
    }
    const form = document.getElementById(`contact-${agent.id}`);
    if (!form) throw new Error('form not found');
    const formData = new FormData(form as HTMLFormElement);
    const username = formData.get('username');
    const phone = trim(formData.get('phone'));
    const email = trim(formData.get('email'));
    const fillerIds = formData.getAll('fillers');
    const fillersCreate = [];
    const fillers = [];

    for (let i = 0, len = fillerIds.length; i < len; i++) {
        const id = fillerIds[i];
        const value = formData.get(`fillers.${id}.${i}`);
        const isNew = formData.get(`fillers.${id}.${i}.new`);
        if (!value) continue;
        if (isNew) fillersCreate.push({filler_id: Number(id), value});
        else fillers.push({user_filler_id: Number(id), value});
    }

    await userService.patch(agent.id, {
        role: agent.role,
        username,
        // an empty field is "none" (a contact from a messenger often has no e-mail)
        phone: phone || null,
        email: email || null,
        fillers,
        fillers_create: fillersCreate,
        company_id: agent.company?.id,
    }).exec();
    contactSnapshots.set(agent.id, contactKey(agent));
    return true;
}

/**
 * The changed contacts, one by one. A contact that cannot be saved does not undo the deal:
 * the toast says which one and why.
 */
async function saveContacts() {
    const failed: string[] = [];
    for (const agent of deal.value.ctr_agents) {
        const result = await promiseResult(updateAgent(agent));
        if (!result.ok) failed.push(`«${agent.username}»: ${result.error.message}`);
    }
    if (failed.length) {
        toast.show({message: 'Сделка сохранена, но не сохранены контакты: ' + failed.join('; '), timeout: 7000, type: 'error'});
    }
}

/** The fields of the form (the same for a new and an existing deal) */
function readForm(target: HTMLFormElement) {
    const formData = new FormData(target);
    const companyFillerIds = formData.getAll('company_fillers');
    const fillerIds = formData.getAll('fillers');
    const form = {
        label: formData.get('label'),
        budget: formData.get('budget'),
        stageId: formData.get('stage[id]'),
        agentId: formData.get('agent[id]'),
        companyId: formData.get('company[id]') as string,
        companyName: (formData.get('company[name]') as string) || '',
        companyEmail: (formData.get('company[email]') as string) || '',
        companyPhone: (formData.get('company[phone]') as string) || '',
        companyFillers: [] as { company_filler_id: number, value: string }[],
        companyFillersCreate: [] as { filler_id: number, value: string }[],
        companyValues: {} as Record<string, string>,
        fillers: [] as { deal_filler_id: number, value: string }[],
        fillersCreate: [] as { filler_id: number, value: string }[],
        fieldsMap: {} as Record<string, string>,
    };

    for (let i = 0, len = fillerIds.length; i < len; i++) {
        const id = fillerIds[i] as string;
        const value = formData.get(`fillers.${id}.${i}`) as string;
        const isNew = formData.get(`fillers.${id}.${i}.new`);
        const tempId = formData.get(`fillers.${id}.${i}.tempId`) as string;
        if (!value) continue;
        if (isNew) form.fillersCreate.push({ filler_id: Number(id), value });
        else form.fillers.push({ deal_filler_id: Number(id), value });
        form.fieldsMap[tempId] = value;
    }

    for (let i = 0, len = companyFillerIds.length; i < len; i++) {
        const id = companyFillerIds[i] as string;
        const value = formData.get(`company_fillers.${id}.${i}`) as string;
        const tempId = formData.get(`company_fillers.${id}.${i}.tempId`) as string;
        const isNew = formData.get(`company_fillers.${id}.${i}.new`);
        if (!value) continue;
        if (isNew) form.companyFillersCreate.push({ filler_id: Number(id), value });
        else form.companyFillers.push({ company_filler_id: Number(id), value });
        form.fieldsMap[tempId] = value;
        form.companyValues[tempId] = value;
    }

    return form;
}

function validateForm(form: ReturnType<typeof readForm>) {
    return validate({
        budget: form.budget,
        agent: form.agentId,
        company: form.companyName,
        companyEmail: form.companyEmail,
        companyPhone: form.companyPhone,
        ...form.fieldsMap,
    });
}

function saveCompanyOf(form: ReturnType<typeof readForm>) {
    return promiseResult(upsertCompany({
        id: form.companyId,
        name: form.companyName,
        email: form.companyEmail,
        phone: form.companyPhone,
        fillers: form.companyFillers,
        fillersCreate: form.companyFillersCreate,
        values: form.companyValues,
    }));
}

// metres and kilos with up to 3 decimals, prices with cents («12,5» typed with a comma too)
const products = () => deal.value.deal_products.map((p) => ({
    quantity: roundTo(toNumber(p.quantity), 3),
    product_id: p.product.id,
    price: roundTo(toNumber(p.price), 2),
}));

async function onCreateImpl(e: Event) {
    const form = readForm(e.target as HTMLFormElement);
    // a new deal also gets the new values of its fields: they are all "fillers" for POST
    const fillers = [...form.fillersCreate, ...form.fillers.map((f) => ({ filler_id: f.deal_filler_id, value: f.value }))];

    const validationResult = validateForm(form);
    if (!validationResult.valid) return showInvalid(validationResult.errors);

    const upsertedCompany = await saveCompanyOf(form);
    if (!upsertedCompany.ok) return toast.show({message: upsertedCompany.error.message, timeout: 4000, type: 'error'});

    const dealCreated = await promiseResult(dealService.create<Deal>({
        label: form.label,
        budget: toSum(form.budget),
        agent_id: Number(form.agentId),
        company_id: upsertedCompany.value ?? undefined,
        ctr_agent_ids: deal.value.ctr_agents.map(c => c.id),
        // no stage chosen -> the API uses the stage for new deals
        stage_id: form.stageId ? Number(form.stageId) : undefined,
        fillers,
        products: products(),
    }).exec());
    if (!dealCreated.ok) return toast.show({message: dealCreated.error.message, timeout: 4000, type: 'error'});
    await saveContacts();
    emits('created', dealCreated.value);
    return dealCreated.value;
}

async function onEditImpl(e: Event) {
    const form = readForm(e.target as HTMLFormElement);

    const validationResult = validateForm(form);
    if (!validationResult.valid) return showInvalid(validationResult.errors);

    const upsertedCompany = await saveCompanyOf(form);
    if (!upsertedCompany.ok) return toast.show({message: upsertedCompany.error.message, timeout: 4000, type: 'error'});
    const companyId = upsertedCompany.value;

    const dealUpdated = await promiseResult(dealService.patch<Deal>(deal.value.id, {
        // an empty label / stage is not sent: the API keeps the current value
        label: form.label || undefined,
        budget: toSum(form.budget),
        agent_id: Number(form.agentId),
        ctr_agent_ids: deal.value.ctr_agents.map(c => c.id),
        // the company field was cleared: the company is taken off the deal
        company_id: companyId ?? (savedCompanyId ? null : undefined),
        // the stage is changed by the same server code as the stage button / kanban drag
        deal_stage_id: form.stageId ? Number(form.stageId) : undefined,
        fillers_create: form.fillersCreate,
        fillers: form.fillers,
        products: products(),
    }).exec());

    if (!dealUpdated.ok) return toast.show({message: dealUpdated.error.message, timeout: 4000, type: 'error'});
    savedCompanyId = companyId;
    if (companyId && !deal.value.company?.id) deal.value.company.id = companyId;
    takeSnapshot();
    await saveContacts();
    emits('updated', dealUpdated.value);
    return dealUpdated.value;
}

const onCreate = (e: Event) => runDealAsync(onCreateImpl(e));
const onEdit = (e: Event) => runDealAsync(onEditImpl(e));

// a new deal starts in the stage for new deals (the one the API would choose)
watchEffect(() => {
    if (!deal.value.id && !deal.value.stage && defaultStage.value) deal.value.stage = defaultStage.value;
});

watch(() => props.users, (initialUsers) => {
    if (!users.value.data.length) users.value.data = initialUsers;
});

onMounted(() => {
    runContacts(contactService.find({ sort: { email: 1 } }).exec());
    runDefaultStage(stagesService.get('default').exec());
});

</script>
