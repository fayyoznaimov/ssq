<script setup lang="ts">
import type { Company, CompanyContact,Contact } from '~/types/user';
import { debounce } from '~/utils/search';

const props = defineProps<{
  contacts: Contact[];
  contactsLoading: boolean;
}>();

const model = defineModel<Contact | Company | null>();
const { run: runCompanies, data: companies } = useAsync<{data: Contact[], count: number}>({ data: [], count: 0 });
const contactService  = useService('contacts', { auth: true });

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

// A typed name that is not in the list comes as { name } without an id: the form that owns
// the field creates the company on save, together with its required fields. It used to be
// created right here with no fields at all: the API refuses that while the company has
// required fields («Страна», «Код Клиента»), and an abandoned form left an empty company.
function onChange(contact?: CompanyContact) {
    if (!contact) return;
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