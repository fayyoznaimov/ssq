<script setup lang="ts">
import { useValidation } from '~/composables/useValidation';
import type { Deal } from '~/types/deal';
import type { Filler } from '~/types/filler';
import { type Company, type CompanyContact,type Contact, type User, type UserContact, UserRole } from '~/types/user';
import { optional, required, validEmail, validPhone } from '~/utils/validation';
import { uploadUrl } from '~/utils/files';

import CompanyAutocomplete from './company-autocomplete.vue';

const props = defineProps<{
  deal: Deal;
  fillers: Filler[];
  contacts: Contact[];
  contactsLoading: boolean;
}>();

const toast = useToast('GlobalToast');
const contactService  = useService('contacts', { auth: true });
const userService = useService('users', { auth: true });
const companyService  = useService('companies', { auth: true });
const { runAsync, isLoading } = useAsync<User>();
const { run: runCtrAgents, data: agents } = useAsync<{data: Contact[], count: number}>({ data: [], count: 0 });
const { deal } = toRefs(props);
const openContact = ref();
const selectedContact = ref<Partial<UserContact>>({ name: '' });
const resetKey = ref(1);

// The API needs the name and the company of a contact; e-mail and phone only when they are given
// (a client from a messenger often has no e-mail). The company of the deal is offered first.
const schema: Schema<string> = {
    email: [optional(validEmail('Неверный формат почты'))],
    phone: [optional(validPhone('Неверный номер телефона'))],
    company: [required('Укажите компанию контакта')],
    contact: [required('Обязательное поле')],
};

const { validate, onChange, errors } = useValidation(schema);

function removeContact(index: number) {
    deal.value.ctr_agents.splice(index, 1);
}

function nameFilter(query?: string, items?: any[]) {
    if (!query || !items) return items;
    const lowercased = query.toLowerCase();
    const filtered = items.filter((item) => item.name.toLowerCase().includes(lowercased));
    if (!filtered.length) filtered.push({ name: query });
    return filtered;
}

function filteredCtrAgents(contacts: Contact[]): {data: Contact[], count: number} {
    const result = contacts.filter((c) => c.type === UserRole.CtrAgent);
    return {data:result, count: result.length};
}

const onCtrAgentInput = debounce((e: Event) => {
    const target = (e.target as HTMLInputElement);
    onChange('contact', target.value);
    runCtrAgents(
        contactService.find({ name: target.value }).exec(),
        (c) => filteredCtrAgents(c.data),
    );
}, 300);

async function onCtrAgentChange(contact: UserContact) {
    if (contact.id) {
        const user = await userService.get<User>(contact.id).exec();
        deal.value.ctr_agents.push(user);
        selectedContact.value = {name: ''};
    }
}

async function onCtrAgentCreate(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const name = formData.get('name');
    const companyName = formData.get('company[name]');
    const email = formData.get('email');
    const phone = formData.get('phone');
    let companyId = Number(formData.get('company[id]'));

    const fillerIds = formData.getAll('fillers');
    const fillers = [];
    const fieldsMap: Record<string, string> = {};
    for (let i = 0, len = fillerIds.length; i < len; i++) {
        const id = fillerIds[i];
        const value = formData.get(`fillers.${id}.${i}`) as string;
        const field = formData.get(`fillers.${id}.${i}.field`) as string;
        if (!value) continue;
        fillers.push({ filler_id: Number(id), value });
        fieldsMap[field] = value;
    }

    const validationResult = validate({
        email,
        phone,
        company: companyName,
        contact: name,
        ...fieldsMap
    });

    if (!validationResult.valid) return;
    if (!companyId) {
        // a name that is not in the list: a company without its required fields is refused by the API
        const newCompany = await promiseResult(companyService.create<Company>({name: String(companyName).trim(), is_old: false, fillers: []}).exec());
        if (!newCompany.ok) {
            return toast.show({message: `Компания «${companyName}» не создана: ${newCompany.error.message}. Выберите компанию из списка.`, timeout: 6000, type: 'error'});
        }
        companyId = newCompany.value.id;
    }

    const values = {
        role: 'ctr_agent',
        username: name,
        company_id: companyId,
        fillers,
        phone: String(phone ?? '').trim() || undefined,
        email: String(email ?? '').trim() || undefined,
        fillers_create: [],
    };

    const user = await promiseResult(runAsync(userService.create<User>(values).exec()));
    if (!user.ok) return toast.show({message: user.error.message, timeout: 3000, type: 'error'});
    deal.value.ctr_agents.push(user.value);
    // this does not clear all fields for some reason
    target.reset();
    resetKey.value++;
    selectedContact.value = {name: ''};
    openContact.value = undefined;
}

watchEffect(() => {
    agents.value = filteredCtrAgents(props.contacts);
});

// a new contact belongs to the company of the deal unless another one is chosen
// (picking a typed name replaces selectedContact, so it is offered again then)
function offerDealCompany() {
    const company: any = deal.value.company;
    const current: any = selectedContact.value;
    if (!current || current.id || current.company || !company?.id) return;
    selectedContact.value = { ...current, company: { id: company.id, name: company.name } };
}

watch(openContact, (value) => {
    if (value === 'new') offerDealCompany();
});
watch(selectedContact, offerDealCompany);

watchEffect(() => {
    for (const filler of props.fillers) {
        if (filler.is_required) schema[filler.field] = [required('Обязательное поле')];
    }
});

</script>
<template>
    <section>
        <!-- the section headings were black on the dark page -->
        <h3 class="block text-sm font-medium text-muted-900 dark:text-muted-100 mb-2">Контакты <span class="text-muted-400">({{ props.deal.ctr_agents?.length ?? 0 }})</span></h3>
        <div class="flex flex-col space-y-4 mt-2">
            <ul class="flex flex-col gap-1">
                <li v-for="(contact, index) in deal.ctr_agents" :key="index">
                    <details class="cursor-pointer group w-full" v-animated-details>
                        <summary
                            class="flex justify-between items-center space-x-2 p-2 rounded-md hover:bg-muted-300 dark:bg-muted-800 dark:hover:bg-muted-700 duration-300 group-open:rounded-b-none group-open:bg-muted-300 group-open:dark:bg-muted-700"
                            @click="openContact = contact.id"
                        >
                            <div class="flex items-center text-muted-900 dark:text-white flex-1 space-x-2">
                                <BaseAvatar
                                    :text="contact.username.slice(0, 2)"
                                    :src="(contact as any).avatar ? uploadUrl((contact as any).avatar) : undefined"
                                    size="sm"
                                    class="bg-primary-400 text-white"
                                />
                                <span>{{ contact?.username }}</span>
                                <!-- where this client can be written to -->
                                <Icon v-if="(contact as any).tg_id" name="ph:telegram-logo" class="size-4 text-sky-500" title="Есть Telegram" />
                                <Icon v-if="(contact as any).wa_id" name="ph:whatsapp-logo" class="size-4 text-emerald-500" title="Есть WhatsApp" />
                            </div>
                            <BaseButtonClose
                                size="sm"
                                rounded="full"
                                color="default"
                                @click="() => removeContact(index)"
                            />
                        </summary>
                        <form
                            :id="'contact-' + contact.id"
                            class="bg-muted-200 p-2 rounded-b-md content dark:bg-muted-800"
                        >
                            <BaseInput
                                label="Имя"
                                name="username"
                                v-model="contact.username"
                            />
                            <BaseInput
                                label="Электронная почта"
                                name="email"
                                v-model="contact.email"
                            />
                            <BaseInput
                                label="Номер телефона"
                                name="phone"
                                v-model="contact.phone"
                            />
                            <ul class="flex flex-col">
                                <li
                                    class="flex items-end gap-2"
                                    v-for="(filler, idx) in contact.user_fillers"
                                >
                                    <input type="hidden" name="fillers" :value="filler.id" />
                                    <input v-if="filler.new" type="hidden" :name="`fillers.${filler.id}.${idx}.new`" value="new" />
                                    <input type="hidden" :name="`fillers.${filler.id}.${idx}.field`" :value="filler.filler.field" />
                                    <BaseInput
                                        :classes="{ wrapper: 'w-full' }"
                                        :label="filler.filler.field"
                                        v-model="filler.value"
                                        :name="`fillers.${filler.id}.${idx}`"
                                    >
                                        <template #action>
                                            <BaseButtonIcon
                                                v-if="false"
                                                rounded="md"
                                                @click="() => contact.user_fillers.splice(idx + 1, 0, { ...filler, id: filler.filler.id, value: '', new: true })"
                                            >
                                                <Icon name="ph:plus" class="size-4" />
                                            </BaseButtonIcon>
                                        </template>
                                    </BaseInput>
                                </li>
                            </ul>
                            <CompanyAutocomplete
                                :contacts="contacts"
                                :contacts-loading="contactsLoading"
                                v-model="contact.company"
                                label="Компания"
                                required
                            />
                        </form>
                    </details>
                </li>
            </ul>
            <details :open="openContact === 'new'" class="group">
                <summary class="group-open:hidden">
                    <BaseButton @click="openContact = 'new'">
                        <Icon name="ph:plus" class="size-4 mr-2" />
                        Добавить контакт
                    </BaseButton>
                </summary>
                <form @submit.prevent="onCtrAgentCreate" novalidate>
                    <BaseAutocomplete
                        v-model="selectedContact"
                        :items="agents.data"
                        :loading="contactsLoading"
                        :display-value="(contact: UserContact) => contact.name"
                        :filter-items="nameFilter"
                        :properties="{ value: 'id', label: 'name' }"
                        placeholder="Добавить контакт"
                        clearable
                        dropdown
                        @input="onCtrAgentInput"
                        @change="onCtrAgentChange"
                        :key="resetKey"
                        :error="errors.contact"
                    />
                    <input type="hidden" name="name" :value="selectedContact.name" />
                    <BaseInput 
                        name="email" 
                        label="Электронная почта" 
                        :error="errors.email"
                        @input="(e: Event) => onChange('email', (e.target as HTMLFormElement).value)"
                        :key="resetKey"
                    />
                    <BaseInput 
                        name="phone" 
                        label="Номер телефона" 
                        :error="errors.phone"
                        @input="(e: Event) => onChange('phone', (e.target as HTMLFormElement).value)"
                        :key="resetKey"
                    />
                    <template v-for="(filler, idx) in fillers" :key="resetKey">
                        <input type="hidden" name="fillers" :value="filler.id" />
                        <input type="hidden" :name="`fillers.${filler.id}.${idx}.field`" :value="filler.field" />
                        <input type="hidden" :name="`fillers.${filler.id}.${idx}.new`" value="new" />
                        <BaseInput
                            :label="filler.field"
                            :name="`fillers.${filler.id}.${idx}`"
                            :required="filler.is_required"
                            :error="errors[filler.field]"
                            @input="(e: Event) => onChange(filler.field, (e.target as HTMLInputElement).value)"
                        />
                    </template>
                    <CompanyAutocomplete
                        :contacts="contacts"
                        :contacts-loading="contactsLoading"
                        v-model="selectedContact.company"
                        name="company"
                        label="Компания"
                        required
                        :error="errors.company"
                        @changed="(contact: CompanyContact) => onChange('company', contact.name)"
                        :key="resetKey"
                    />
                    <div class="flex gap-2">
                        <BaseButton type="submit" class="mt-4" v-if="!selectedContact?.id" :disabled="isLoading">Сохранить</BaseButton>
                        <BaseButton class="mt-4" variant="pastel" type="button" @click="openContact = undefined">Отменить</BaseButton>
                    </div>
                </form>
            </details>
        </div>
    </section>
</template>
