<script setup lang="ts">
import Modal from '~/components/common/Modal.vue';
import type { Filler, FillersResponse } from '~/types/filler';
import type { Email } from '~/types/mail';
import { type Company, type Contact, type User, UserRole } from '~/types/user';
import { promiseResult } from '~/utils/result';
import { debounce } from '~/utils/search';

/**
 * Creates CRM contacts (ctr_agent) from the senders of the selected emails; the stored letters
 * from those addresses then point to the new contacts (POST /emails/contacts).
 *
 * The server requires the custom fields marked "Обязательное" (today
 * "Должность" for a contact, "Страна" and "Код Клиента" for a company), so the
 * form shows them the same way the contact and company pages do. A contact
 * must belong to a company: an existing one is picked, or a new one is
 * created together with its required fields.
 */

type FillerInput = Filler & { value: string };
type CompanyChoice = { id?: number; name: string };
type ContactDraft = {
    address: string;
    username: string;
    phone: string;
    fillers: FillerInput[];
    company: CompanyChoice | null;
    companyFillers: FillerInput[];
};

const props = defineProps<{ id: string, emails: Email[] }>();
const modal = useModal(props.id);
const emits = defineEmits<{
    (e: 'saved', value: User[]): void;
}>();

const toast = useToast('GlobalToast');
const { runAsync, isLoading } = useAsync();
const userService = useService('users', { auth: true });
const companyService = useService('companies', { auth: true });
const contactService = useService('contacts', { auth: true });
const fillersService = useService('fillers', { auth: true });
const mailService = useService('emails', { auth: true });
const { run: runFillers, data: fillers, isLoading: fillersLoading } = useAsync<FillersResponse>({ user: [], company: [] });
const { run: runCompanies, data: companies, isLoading: companiesLoading } = useAsync<{ data: Contact[], count: number }>({ data: [], count: 0 });

const drafts = ref<ContactDraft[]>([]);

const companyOptions = computed<CompanyChoice[]>(() =>
    companies.value.data
        .filter((c) => c.type === 'company')
        .map((c) => ({ id: c.id, name: c.name })),
);

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;

/** The counterpart of the email: the sender, or the first recipient of an outgoing one. */
function counterpart(email: Email): string {
    const raw = email.outgoing ? (email.to[0]?.value ?? '') : (email.from ?? '');
    return (raw.match(ADDRESS)?.[0] ?? raw).toLowerCase();
}

/** "ivan.petrov" -> "Ivan Petrov": a starting point for the name, not the truth. */
function guessName(address: string): string {
    const local = address.split('@')[0] ?? '';
    return local
        .split(/[._-]+/)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(' ');
}

function withValues(list: Filler[] = []): FillerInput[] {
    return list.map((filler) => ({ ...filler, value: '' }));
}

function buildDrafts() {
    const seen = new Set<string>();
    drafts.value = [];
    for (const email of props.emails) {
        const address = counterpart(email);
        if (!address || seen.has(address)) continue;
        seen.add(address);
        drafts.value.push({
            address,
            username: guessName(address),
            phone: '',
            fillers: withValues(fillers.value.user),
            company: null,
            companyFillers: withValues(fillers.value.company),
        });
    }
}

function nameFilter(query?: string, items?: CompanyChoice[]) {
    if (!query || !items) return items;
    const lowercased = query.toLowerCase();
    const filtered = items.filter((item) => item.name.toLowerCase().includes(lowercased));
    // Allow a company that does not exist yet
    if (!filtered.some((item) => item.name.toLowerCase() === lowercased)) filtered.push({ name: query });
    return filtered;
}

const onCompanyInput = debounce((e: Event) => {
    const target = e.target as HTMLInputElement;
    runCompanies(contactService.find({ name: target.value }).exec());
}, 400);

function isNewCompany(draft: ContactDraft) {
    return !!draft.company && !draft.company.id;
}

function toFillerPayload(list: FillerInput[]) {
    return list
        .filter((filler) => filler.value && filler.value.trim())
        .map((filler) => ({ filler_id: filler.id, value: filler.value.trim() }));
}

async function onSubmit() {
    const created: User[] = [];
    // The same new company named for two contacts is created once
    const newCompanies = new Map<string, number>();

    for (const draft of drafts.value) {
        if (!draft.company?.name?.trim()) {
            return toast.show({ message: `Выберите компанию для ${draft.address}`, type: 'error', timeout: 3000 });
        }

        let companyId = draft.company.id;
        if (!companyId) {
            const key = draft.company.name.trim().toLowerCase();
            companyId = newCompanies.get(key);
            if (!companyId) {
                const company = await promiseResult(runAsync(companyService.create<Company>({
                    name: draft.company.name.trim(),
                    is_old: false,
                    fillers: toFillerPayload(draft.companyFillers),
                }).exec()));
                if (!company.ok) return toast.show({ message: company.error.message, type: 'error', timeout: 4000 });
                companyId = company.value.id;
                newCompanies.set(key, companyId);
            }
        }

        const payload: Record<string, unknown> = {
            role: UserRole.CtrAgent,
            username: draft.username.trim(),
            email: draft.address,
            company_id: companyId,
            fillers: toFillerPayload(draft.fillers),
            fillers_create: [],
        };
        if (draft.phone.trim()) payload.phone = draft.phone.trim();

        const user = await promiseResult(runAsync(userService.create<User>(payload).exec()));
        if (!user.ok) return toast.show({ message: user.error.message, type: 'error', timeout: 4000 });
        created.push(user.value);
    }

    // the stored letters from these addresses now point to the contacts (MAIL-16); a failure here
    // does not undo the contacts, it is only told
    const linked = await promiseResult(mailService.post('contacts', { user_ids: created.map((user) => user.id) }).exec());
    if (!linked.ok) toast.show({ message: `Контакты созданы, но письма к ним не привязаны: ${linked.error.message}`, type: 'error', timeout: 5000 });

    toast.show({ message: created.length === 1 ? 'Контакт создан' : `Создано контактов: ${created.length}`, type: 'success', timeout: 3000 });
    emits('saved', created);
    modal.close();
}

watch(() => props.emails, buildDrafts, { deep: true });
watch(fillers, buildDrafts);

onMounted(() => {
    runFillers(fillersService.find().exec());
    runCompanies(contactService.find({ limit: 50 }).exec());
});

</script>
<template>
    <Modal :id="props.id" size="lg">
        <template #header>
            <div class="flex">
                <h2>Создать контакты</h2>
            </div>
        </template>
        <form id="contact-form" class="flex flex-col gap-6" @submit.prevent="onSubmit">
            <p v-if="!drafts.length" class="text-sm text-muted-500">
                Отметьте письма, из которых нужно создать контакты.
            </p>
            <BasePlaceload v-if="fillersLoading" class="h-2 w-full" />
            <fieldset
                v-for="draft in drafts"
                :key="draft.address"
                class="flex flex-col gap-3 rounded-md border border-muted-200 dark:border-muted-700 p-3"
            >
                <legend class="px-1 text-sm text-muted-500 dark:text-muted-400">{{ draft.address }}</legend>
                <BaseInput
                    v-model="draft.username"
                    type="text"
                    label="Имя *"
                    placeholder="пр.: Иван Петров"
                    icon="ph:user"
                    required
                    :name="`username.${draft.address}`"
                />
                <BaseInput
                    :model-value="draft.address"
                    type="email"
                    label="Почта"
                    icon="ph:at"
                    readonly
                    :name="`email.${draft.address}`"
                />
                <BaseInput
                    v-model="draft.phone"
                    type="text"
                    label="Номер телефона"
                    placeholder="пр.: +998901200000"
                    icon="ph:phone"
                    :name="`phone.${draft.address}`"
                />
                <BaseInput
                    v-for="filler in draft.fillers"
                    :key="`user-${draft.address}-${filler.id}`"
                    v-model="filler.value"
                    type="text"
                    :label="filler.is_required ? `${filler.field} *` : filler.field"
                    placeholder="Введите значение"
                    :required="filler.is_required"
                    :name="`fillers.${draft.address}.${filler.id}`"
                />
                <BaseAutocomplete
                    v-model="draft.company"
                    label="Компания *"
                    placeholder="Выберите или введите название"
                    :items="companyOptions"
                    :loading="companiesLoading"
                    :display-value="(company: CompanyChoice) => company?.name ?? ''"
                    :properties="{ value: 'id', label: 'name' }"
                    :filter-items="nameFilter"
                    :fixed="true"
                    dropdown
                    clearable
                    @input="onCompanyInput"
                />
                <div
                    v-if="isNewCompany(draft)"
                    class="flex flex-col gap-3 rounded-md bg-muted-50 dark:bg-muted-900 p-3"
                >
                    <p class="text-sm text-muted-600 dark:text-muted-300">
                        Компания «{{ draft.company?.name }}» будет создана
                    </p>
                    <BaseInput
                        v-for="filler in draft.companyFillers"
                        :key="`company-${draft.address}-${filler.id}`"
                        v-model="filler.value"
                        type="text"
                        :label="filler.is_required ? `${filler.field} *` : filler.field"
                        placeholder="Введите значение"
                        :required="filler.is_required"
                        :name="`company_fillers.${draft.address}.${filler.id}`"
                    />
                </div>
            </fieldset>
        </form>
        <template #footer>
            <div class="flex gap-2">
                <BaseButton
                    type="submit"
                    form="contact-form"
                    color="primary"
                    :loading="isLoading"
                    :disabled="isLoading || fillersLoading || !drafts.length"
                >
                    Сохранить
                </BaseButton>
                <BaseButton @click="modal.close">
                    Отменить
                </BaseButton>
            </div>
        </template>
    </Modal>
</template>
