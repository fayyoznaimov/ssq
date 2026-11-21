<script setup lang="ts">
import type { Company, CompanyContact,Contact } from '~/types/user';
import { debounce } from '~/utils/search';

const props = defineProps<{
  contacts: Contact[];
  contactsLoading: boolean;
}>();

const model = defineModel<Contact | Company | null>();
const toast = useToast('GlobalToast');
const { run: runCompanies, data: companies } = useAsync<{data: Contact[], count: number}>({ data: [], count: 0 });
const contactService  = useService('contacts', { auth: true });
const companyService  = useService('companies', { auth: true });

function filteredCompanies(contacts: Contact[]): {data: Contact[], count: number} {
    const result = contacts.filter((c) => c.type === 'company');
    return {data: result, count: result.length};
}

function nameFilter(query?: string, items?: any[]) {
    if (!query || !items) return items;
    const lowercased = query.toLowerCase();
    const filtered = items.filter((item) => item.name.toLowerCase().includes(lowercased));
    if (!filtered.length) filtered.push({ name: query });
    return filtered;
}

watchEffect(() => {
    companies.value = filteredCompanies(props.contacts);
});

const onCompanyInput = debounce((e: Event) => {
    const target = (e.target as HTMLInputElement);
    runCompanies(
        contactService.find({ name: target.value }).exec(),
        (c) => filteredCompanies(c.data)
    );
}, 500);

async function onChange(contact?: CompanyContact) {
    if (!contact) return;
    if (!contact.id && contact.name?.length > 3) {
        const company = await promiseResult(companyService.create<Company>({
            name: contact.name,
            fillers: [],
            is_old: false,
        }).exec());
        if (!company.ok) return toast.show({message: company.error.message, timeout: 3000, type: 'error'});
        if (model.value) model.value.id = company.value.id;
        return emits('changed', contact);
    }
    emits('changed', contact);
}

const emits = defineEmits<{
    (e: 'changed', company: CompanyContact): void,
}>();

</script>
<template>
    <div>
        <BaseAutocomplete
            v-model="model"
            :items="companies.data"
            :loading="contactsLoading"
            :display-value="(company: Company) => company?.name"
            :properties="{ value: 'id', label: 'name' }"
            :filter-items="nameFilter"
            clearable
            dropdown
            @input="onCompanyInput"
            @change="onChange"
            v-bind="$attrs"
        />
    </div>
</template>