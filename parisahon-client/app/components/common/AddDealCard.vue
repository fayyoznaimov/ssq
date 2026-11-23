<template>
    <div
        class="border border-dashed border-gray-300 dark:border-muted-600 justify-center px-2 rounded-md cursor-pointer bg-muted-100 add-deal-card dark:border-muted-700 dark:bg-muted-800"
        @click="openAddDealField = true"
    >
        <p
            v-if="!openAddDealField"
            class="text-gray-400 text-sm text-center my-4"
        >
            Быстрое добавление
        </p>
        <form
            v-else
            class="space-y-3 py-3"
            @submit.prevent="onSubmit"
            novalidate
        >
            <BaseInput
                v-model="deal.label"
                placeholder="Название"
            />
            <BaseInput 
                v-model="deal.budget" 
                placeholder="Бюджет" 
                type="number" 
                min="0"
                :error="errors.budget" 
                @input="(e: Event) => onChange('budget', (e.target as HTMLInputElement).value)"
                :key="resetKey"
            />
            <div class="border border-muted-300 rounded-md dark:border-muted-700">
                <BaseAutocomplete
                    :items="agents.data"
                    :loading="contactsLoading"
                    :display-value="(contact: UserContact) => contact.name"
                    :filter-items="nameFilter"
                    :properties="{ value: 'id', label: 'name' }"
                    placeholder="Контакт: Имя"
                    clearable
                    dropdown
                    @input="onCtrAgentInput"
                    @change="onCtrAgentChange"
                    :error="errors.contactName" 
                    :key="resetKey"
                    :classes="{input: 'border-none !outline-none !rounded-b-none rounded-t-md'}"
                />
                <BaseInput 
                    name="email" 
                    placeholder="Контакт: Email" 
                    :key="resetKey"
                    class="border-t border-t-muted-200 !border-x-0 !outline-none !rounded-none"
                    :error="errors.contactEmail"
                    v-model="ctrAgent.email"
                    @input="(e: Event) => onChange('contactEmail', (e.target as HTMLInputElement).value)"
                />
                <BaseInput 
                    name="phone" 
                    placeholder="Контакт: Телефон"
                    :key="resetKey"
                    class="border-none !outline-none rounded-b-md !rounded-t-none"
                    :error="errors.contactPhone"
                    @input="(e: Event) => onChange('contactPhone', (e.target as HTMLInputElement).value)"
                    v-model="ctrAgent.phone"
                />
            </div>
            <CompanyAutocomplete 
                :contacts="contacts.data"
                :contacts-loading="contactsLoading"
                v-model="deal.company"
                @changed="(contact: CompanyContact) => onChange('company', contact.name)"
                name="company"
                placeholder="Компания: Название"
                :error="errors.company"
                :key="resetKey"
            />
            <div class="flex items-center justify-between">
                <div class="space-x-2">
                    <BaseButton
                        color="primary"
                        size="sm"
                        type="submit"
                        :disabled="creatingDeal"
                    >
                        Добавить
                    </BaseButton>
                    <BaseButton
                        size="sm"
                        color="none"
                        @click.stop="openAddDealField = false"
                        :disabled="creatingDeal"
                    >
                        Отменить
                    </BaseButton>
                </div>
            </div>
        </form>
    </div>
</template>

<script setup lang="ts">
import CompanyAutocomplete from '~/components/deal/company-autocomplete.vue';
import type { Deal, Stage } from '~/types/deal';
import { type CompanyContact, type Contact, type User, type UserContact,UserRole } from '~/types/user';

const props = defineProps<{stage: Stage}>();

const user = useState<User>('user');
const contactService  = useService('contacts', { auth: true });
const userService  = useService('users', { auth: true });
const dealService = useService('deals', {auth: true});
const openAddDealField = ref(false);
const ctrAgent = ref<Partial<User>>({});
const deal = ref<Partial<Deal>>({
    agent: user.value,
    stage: props.stage,
    ctr_agents: [],
});

const emits = defineEmits<{
    (e: 'deal:created', value: Deal): void
}>();

const toast = useToast('GlobalToast');
const resetKey = ref(1);
const { run: runContacts, isLoading: contactsLoading, data: contacts } = useAsync<{data: Contact[], count: number}>({ data: [], count: 0 });
const { run: runCtrAgents, data: agents } = useAsync<{data: Contact[], count: number}>({ data: [], count: 0 });
const { runAsync: runDealAsync, isLoading: creatingDeal } = useAsync<Deal>();

watchEffect(() => {
    agents.value = filteredCtrAgents(contacts.value.data);
});

// Only what the API needs: a deal may come without a contact and without a company (as from
// Telegram). A new contact needs a company of the list (the API links every contact to one);
// e-mail and phone are checked when given.
const schema: Schema<string> = {
    budget: [optional((value: unknown) => /^\d+$/.test(String(value ?? '').trim()) ? { ok: true as const, value: undefined } : { ok: false as const, error: 'Бюджет — целое число' })],
    company: [(value: unknown) => value === 'typed' ? { ok: false as const, error: 'Выберите компанию из списка' } : { ok: true as const, value: undefined }],
    contactName: [],
    contactEmail: [optional(validEmail('Неверный email'))],
    contactPhone: [optional(validPhone('Неверный номер телефона'))],
};

const { validate, onChange, errors } = useValidation(schema);

function filteredCtrAgents(contacts: Contact[]): {data: Contact[], count: number} {
    const result = contacts.filter((c) => c.type === UserRole.CtrAgent);
    return {data:result, count: result.length};
}

const onCtrAgentInput = debounce((e: Event) => {
    const target = (e.target as HTMLInputElement);
    onChange('contactName', target.value);
    runCtrAgents(
        contactService.find({ name: target.value }).exec(),
        (c) => filteredCtrAgents(c.data),
    );
}, 300);

async function onCtrAgentChange(contact: UserContact) {
    if (contact?.id) {
        const user = await userService.get<User>(contact.id).exec();
        ctrAgent.value = user;
        onChange('contactName', user.username);
        onChange('contactEmail', user.email);
        onChange('contactPhone', user.phone);
    } else if (contact && !Array.isArray(contact) && contact.name) {
        // a new contact by the typed name (it was never taken before, so a new contact could not be added)
        const typed = ctrAgent.value.id ? {} : ctrAgent.value;
        ctrAgent.value = { email: typed.email, phone: typed.phone, username: contact.name };
        onChange('contactName', contact.name);
    } else {
        ctrAgent.value = {};
    }
}

function nameFilter(query?: string, items?: any[]) {
    if (!query || !items) return items;
    const lowercased = query.toLowerCase();
    const filtered = items.filter((item) => item.name.toLowerCase().includes(lowercased));
    if (!filtered.length) filtered.push({ name: query });
    return filtered;
}

async function onSubmit() {
    const company: any = deal.value.company;
    const companyName = company && !Array.isArray(company) ? String(company.name ?? '').trim() : '';
    const contactName = String(ctrAgent.value.username ?? '').trim();
    const validationResult = validate({
        budget: deal.value.budget,
        // a typed name is not a company yet: it has required fields this card does not have
        company: companyName && !company.id ? 'typed' : 'ok',
        contactName,
        contactEmail: ctrAgent.value.email,
        contactPhone: ctrAgent.value.phone,
    });
    if (!validationResult.valid) return;
    if (contactName && !ctrAgent.value.id && !company?.id) {
        return toast.show({message: 'Новому контакту нужна компания: выберите её из списка', timeout: 4000, type: 'error'});
    }

    if (contactName && !ctrAgent.value.id) {
        const user = await promiseResult(userService.create<User>({
            role: 'ctr_agent',
            username: contactName,
            email: String(ctrAgent.value.email ?? '').trim() || undefined,
            phone: String(ctrAgent.value.phone ?? '').trim() || undefined,
            fillers_create: [],
            company_id: company?.id,
            fillers: [],
        }).exec());

        if (!user.ok) return toast.show({message: user.error.message, timeout: 3000, type: 'error'});
        ctrAgent.value = user.value;
    }

    const dealCreated = await promiseResult(runDealAsync(dealService.create<Deal>({
        label: deal.value.label ?? '',
        budget: Number(deal.value.budget) || 0,
        agent_id: Number(deal.value.agent?.id),
        ctr_agent_ids: ctrAgent.value.id ? [ctrAgent.value.id] : [],
        company_id: company?.id || undefined,
        stage_id: props.stage.id,
        fillers: [],
        products: [],
    }).exec()));

    if (!dealCreated.ok) return toast.show({message: dealCreated.error.message, timeout: 3000, type: 'error'});
    resetKey.value++;
    openAddDealField.value = false;
    // the next quick deal starts empty
    ctrAgent.value = {};
    deal.value = { agent: user.value, stage: props.stage, ctr_agents: [] };
    emits('deal:created', dealCreated.value);
}

onMounted(() => {
    runContacts(contactService.find({ sort: { email: 1 } }).exec());
});

</script>

<style scoped>

</style>
