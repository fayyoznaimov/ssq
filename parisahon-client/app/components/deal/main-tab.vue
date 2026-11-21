<template>
    <div class="flex flex-col h-full">
        <form id="deal-form" @submit.prevent="onSubmit" novalidate></form>
        <div class="flex flex-col justif space-y-6 max-h-[40rem] px-2 overflow-y-auto no-scrollbar">
            <section>
                <div class="flex flex-col space-y-4 mt-2">
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
                        v-model="deal.budget"
                        required
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
                <span class="text-medium text-muted-900">Компания</span>
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
                    required 
                    form="deal-form"
                    @input="(e: Event) => onChange('companyEmail', (e.target as HTMLInputElement).value)"
                    :error="errors.companyEmail"
                />
                <BaseInput 
                    v-model="deal.company.phone" 
                    name="company[phone]" 
                    label="Номер телефона" 
                    required 
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
                            :required="filler.filler.is_required"
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
        <div class="py-8 flex space-x-2 mt-auto">
            <NuxtLink :to="route.query.from">
                <BaseButton type="button" :disabled="upsertingDeal">
                    Отменить
                </BaseButton>
            </NuxtLink>
            <Can I="update" :this="subject('Deal', deal)">
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
import type { Deal } from '~/types/deal';
import type { Stage } from '~/types/stage';
import type { Filler } from '~/types/filler';
import type { Settings } from '~/types/settings';
import type { Company, CompanyContact, Contact, User } from '~/types/user';
import { promiseResult } from '~/utils/result';
import { debounce } from '~/utils/search';
import { required, type Schema,validNumber } from '~/utils/validation';

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
const settingsService  = useService('settings', { auth: true });
const dealService = useService('deals', { auth: true });

const { run: runContacts, isLoading: contactsLoading, data: contacts } = useAsync<{data: Contact[], count: number}>({ data: [], count: 0 });
const { run: runUsers, data: users } = useAsync<{data: User[], count: number}>({ data: props.users, count: 0 });
const { runAsync: runDealAsync, isLoading: upsertingDeal } = useAsync();
const { run: runSettings, data: settings } = useAsync<Settings>();

const route = useRoute();
const sortedStages = computed(() => props.stages.sort((a, b) => a.order - b.order));
const toast = useToast('GlobalToast');
const deal = computed(() => props.deal);

const schema: Schema<string> = {
    budget: [required('Обязательное поле'), validNumber('Неверный бюджет')],
    agent: [required('Обязательное поле')],
    company: [required('Обязательное поле')],
    companyEmail: [required('Обязательное поле'), validEmail('Неверный формат почты')],
    companyPhone: [required('Обязательное поле'), validPhone('Неверный номер телефона')],
};

const { validate, onChange, errors } = useValidation(schema);

// TODO: remove duplication somehow 
watch(() => props.fillers, () => {
    for (const filler of props.fillers.deal || []) {
        if (deal.value.deal_fillers.some((df) => df.filler.id === filler.id)) continue;
        const fillerValue = {
            id: filler.id,
            value: '',
            filler,
            new: true,
            created_at: new Date().toISOString(),
            tempId: Math.random().toString(32).slice(2),
        };
        deal.value.deal_fillers.push(fillerValue);
        if (filler.is_required) schema[filler.id] = [required('Обязательное поле')];
    }

    for (const filler of props.fillers.company || []) {
        if (deal.value.company?.company_fillers?.some((cf) => cf.filler.id === filler.id)) continue;
        if (!deal.value.company?.company_fillers) deal.value.company.company_fillers = [];
        const fillerValue = {
            id: filler.id,
            value: '',
            filler,
            new: true,
            created_at: new Date().toISOString(),
            tempId: Math.random().toString(32).slice(2),
        };
        deal.value.company.company_fillers.push(fillerValue);
        if (filler.is_required) schema[filler.id] = [required('Обязательное поле')];
    }

    for (const filler of props.fillers.user || []) {
        for (const agent of deal.value.ctr_agents) {
            if (agent.user_fillers.some((uf) => uf.filler.id === filler.id)) continue;
            const fillerValue = {
                id: filler.id,
                value: '',
                filler,
                new: true,
                created_at: new Date().toISOString(),
                tempId: Math.random().toString(32).slice(2),
            };
            agent.user_fillers.push(fillerValue);
            if (filler.is_required) schema[filler.id] = [required('Обязательное поле')];
        }
    }
});

const onAgentInput = debounce((e: Event) => {
    const target = (e.target as HTMLInputElement);
    runUsers(userService.find({ username: target.value }).exec());
}, 500);

async function onCompanyChanged(contact: CompanyContact) {
    onChange('company', contact.name);
    if (contact.id) {
        const company = await companyService.get<Company>(contact.id).exec();
        deal.value.company.company_fillers = company.company_fillers;
        deal.value.company.email = company.email;
        deal.value.company.phone = company.phone;
        onChange('companyEmail', company.email);
        onChange('companyPhone', company.phone);
        for (const filler of props.fillers.company || []) {
            if (deal.value.company?.company_fillers?.some((cf) => cf.filler.id === filler.id)) continue;
            if (!deal.value.company?.company_fillers) deal.value.company.company_fillers = [];
            const fillerValue = {
                id: filler.id,
                value: '',
                filler,
                new: true,
                created_at: new Date().toISOString(),
                tempId: Math.random().toString(32).slice(2),
            };
            deal.value.company.company_fillers.push(fillerValue);
        }
    }
}

async function onSubmit(e: Event) {
    if (deal.value.id) await onEdit(e);
    else await onCreate(e);
}

async function upsertCompany({id, email, phone, name, fillers, fillersCreate}: {
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
}) {
    if (id) {
        await companyService.patch(id as string, {
            name, email, phone, fillers, fillers_create: fillersCreate, is_old: false
        }).exec();
        return Number(id);
    }

    const created = await companyService.create<Company>({
        email,
        name,
        phone,
        fillers: fillersCreate,
        users: [],
        is_old: false,
    }).exec();
    if (created?.id) return created.id;

    const found = await companyService.find<{data: Company[]}>({ name }).exec();
    const company = found.data.find((c) => c.name === name);
    if (!company) throw new Error('Не удалось создать компанию');
    return company.id;
}

async function updateAgent(agent: User) {
    const form = document.getElementById(`contact-${agent.id}`);
    if (!form) throw new Error('form not found');
    const formData = new FormData(form as HTMLFormElement);
    const username = formData.get('username');
    const phone = formData.get('phone');
    const email = formData.get('email');
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
        phone, 
        email, 
        fillers, 
        fillers_create: fillersCreate,
        company_id: agent.company?.id,
    }).exec();
}

async function onCreateImpl(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const label = formData.get('label');
    const budget = formData.get('budget');
    const stageId = formData.get('stage[id]');
    const agentId = formData.get('agent[id]');
    const companyId = formData.get('company[id]') as string;
    const companyName = formData.get('company[name]') as string;
    const companyEmail = formData.get('company[email]') as string;
    const companyPhone = formData.get('company[phone]') as string;
    const companyFillerIds = formData.getAll('company_fillers');
    const companyFillersCreate = [];
    const companyFillers = [];
    const fillerIds = formData.getAll('fillers');
    const fillers = [];
    const fieldsMap: Record<string, string> = {};

    for (let i = 0, len = fillerIds.length; i < len; i++) {
        const id = fillerIds[i] as string;
        const value = formData.get(`fillers.${id}.${i}`) as string;
        const tempId = formData.get(`fillers.${id}.${i}.tempId`) as string;
        if (!value) continue;
        fillers.push({ filler_id: Number(id), value });
        fieldsMap[tempId] = value;
    }

    for (let i = 0, len = companyFillerIds.length; i < len; i++) {
        const id = companyFillerIds[i] as string;
        const value = formData.get(`company_fillers.${id}.${i}`) as string;
        const tempId = formData.get(`company_fillers.${id}.${i}.tempId`) as string;
        const isNew = formData.get(`company_fillers.${id}.${i}.new`);
        if (!value) continue;
        if (isNew) companyFillersCreate.push({filler_id: Number(id), value });
        else companyFillers.push({company_filler_id: Number(id), value});
        fieldsMap[tempId] = value;
    }

    const validationResult = validate({
        budget,
        agent: agentId,
        company: companyName,
        companyEmail: companyEmail,
        companyPhone: companyPhone,
        ...fieldsMap
    });

    if (!validationResult.valid) return;
    const upsertedCompany = await promiseResult(upsertCompany({
        id: companyId,
        name: companyName,
        email: companyEmail,
        phone: companyPhone,
        fillers: companyFillers as any,
        fillersCreate: companyFillersCreate as any,
    }));
    if (!upsertedCompany.ok) return toast.show({message: upsertedCompany.error.message, timeout: 3000, type: 'error'});
    let updatedAgents = await promiseResult(Promise.all(deal.value.ctr_agents.map(updateAgent)));
    if (!updatedAgents.ok) return toast.show({message: updatedAgents.error.message, timeout: 3000, type: 'error'});
    const dealCreated = await promiseResult(dealService.create<Deal>({
        label,
        budget: Number(budget),
        agent_id: Number(agentId),
        company_id: upsertedCompany.value,
        ctr_agent_ids: deal.value.ctr_agents.map(c => c.id),
        // no stage chosen -> the API uses the default stage from settings
        stage_id: stageId ? Number(stageId) : undefined,
        fillers,
        products: deal.value.deal_products.map((p) => ({quantity: Number(p.quantity), product_id: p.product.id, price: Number(p.price) })),
    }).exec());
    if (!dealCreated.ok) return toast.show({message: dealCreated.error.message, timeout: 3000, type: 'error'});
    emits('created', dealCreated.value);
    return dealCreated.value;
}

async function onEditImpl(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const label = formData.get('label');
    const budget = formData.get('budget');
    const stageId = formData.get('stage[id]');
    const agentId = formData.get('agent[id]');
    const companyId = formData.get('company[id]') as string;
    const companyName = formData.get('company[name]') as string;
    const companyEmail = formData.get('company[email]') as string;
    const companyPhone = formData.get('company[phone]') as string;
    const companyFillerIds = formData.getAll('company_fillers');
    const companyFillersCreate = [];
    const companyFillers = [];
    const fillerIds = formData.getAll('fillers');
    const fillersCreate = [];
    const fillers = [];
    const fieldsMap: Record<string, string> = {};

    for (let i = 0, len = fillerIds.length; i < len; i++) {
        const id = fillerIds[i] as string;
        const value = formData.get(`fillers.${id}.${i}`) as string;
        const isNew = formData.get(`fillers.${id}.${i}.new`);
        const tempId = formData.get(`fillers.${id}.${i}.field`) as string;
        if (!value) continue;
        if (isNew) fillersCreate.push({ filler_id: Number(id), value });
        else fillers.push({deal_filler_id: Number(id), value });
        fieldsMap[tempId] = value;
    }

    for (let i = 0, len = companyFillerIds.length; i < len; i++) {
        const id = companyFillerIds[i] as string;
        const value = formData.get(`company_fillers.${id}.${i}`) as string;
        const tempId = formData.get(`company_fillers.${id}.${i}.tempId`) as string;
        const isNew = formData.get(`company_fillers.${id}.${i}.new`);
        if (!value) continue;
        if (isNew) companyFillersCreate.push({filler_id: Number(id), value });
        else companyFillers.push({company_filler_id: Number(id), value});
        fieldsMap[tempId] = value;
    }

    const validationResult = validate({ 
        budget,
        agent: agentId,
        company: companyName,
        companyEmail: companyEmail,
        companyPhone: companyPhone,
        ...fieldsMap
    });

    if (!validationResult.valid) return;

    const upsertedCompany = await promiseResult(upsertCompany({
        id: companyId,
        name: companyName,
        email: companyEmail,
        phone: companyPhone,
        fillers: companyFillers as any,
        fillersCreate: companyFillersCreate as any,
    }));

    if (!upsertedCompany.ok) return toast.show({message: upsertedCompany.error.message, timeout: 3000, type: 'error'});
    let updatedAgents = await promiseResult(Promise.all(deal.value.ctr_agents.map(updateAgent)));
    if (!updatedAgents.ok) return toast.show({message: updatedAgents.error.message, timeout: 3000, type: 'error'});

    const dealUpdated = await promiseResult(dealService.patch<Deal>(deal.value.id, {
        // an empty label / stage is not sent: the API keeps the current value
        label: label || undefined,
        budget: Number(budget),
        agent_id: Number(agentId),
        ctr_agent_ids: deal.value.ctr_agents.map(c => c.id),
        company_id: upsertedCompany.value,
        // the stage is changed by the same server code as the stage button / kanban drag
        deal_stage_id: stageId ? Number(stageId) : undefined,
        fillers_create: fillersCreate,
        fillers,
        products: deal.value.deal_products.map((p) => ({ quantity: Number(p.quantity), product_id: p.product.id, price: Number(p.price) })),
    }).exec());

    if (!dealUpdated.ok) return toast.show({message: dealUpdated.error.message, timeout: 3000, type: 'error'});
    emits('updated', dealUpdated.value);
    return dealUpdated.value;
}

const onCreate = (e: Event) => runDealAsync(onCreateImpl(e));
const onEdit = (e: Event) => runDealAsync(onEditImpl(e));

watchEffect(() => {
    if (settings.value && !deal.value.stage) deal.value.stage = settings.value.default_stage;
});

watch(() => props.users, (initialUsers) => {
    if (!users.value.data.length) users.value.data = initialUsers;
});

onMounted(() => {
    runContacts(contactService.find({ sort: { email: 1 } }).exec());
    runSettings(settingsService.find().exec());
});

</script>
