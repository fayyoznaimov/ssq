<template>
    <!-- no column gaps below lg: 11 gaps of 2rem were wider than a phone and pushed the card off the right edge -->
    <div class="grid grid-cols-12 gap-x-0 gap-y-6 lg:gap-8 px-4 lg:px-10 lg:h-[calc(100vh-6.4rem)]">
        <form
            class="col-span-12 lg:col-span-4 rounded-md"
            @submit.prevent="onSubmit"
        >
            <BaseTabs
                v-model="activeTab"
                :tabs
            >
                <template #tab="{ activeValue }">
                    <!--  GENERAL  -->
                    <section
                        v-if="activeValue === 'general'"
                        class="max-w-sm flex flex-col gap-3"
                        novalidate
                    >
                        <CardRecognition
                            :company-id="company.id"
                            @recognized="onRecognized"
                        />
                        <BaseInput
                            v-model="company.name"
                            type="text"
                            label="Название компании*"
                            name="name"
                            placeholder="пр.: Parisa"
                            icon="ph:buildings"
                            :loading="companyLoading"
                            required
                            :error="errors.name || recognitionWarning('name')"
                            @input="(e: Event) => onChange('name', (e.target as HTMLInputElement).value)"
                        />
                        <BaseInput
                            v-model="company.phone"
                            type="text"
                            label="Номер телефона"
                            name="phone"
                            placeholder="пр.: +998901200000"
                            icon="ph:phone"
                            :loading="companyLoading"
                            required
                            :error="errors.phone || recognitionWarning('phone')"
                            @input="(e: Event) => onChange('phone', (e.target as HTMLInputElement).value)"
                        />
                        <p v-if="company.phone_from_contact" class="-mt-2 text-xs text-muted-500">Телефон основного контакта ({{ company.phone_from_contact }}); сохранится как телефон компании.</p>
                        <BaseInput
                            v-model="company.email"
                            type="email"
                            label="Электронная почта"
                            name="email"
                            placeholder="пр.: jane@doe.com"
                            icon="ph:envelope"
                            :loading="companyLoading"
                            :error="errors.email || recognitionWarning('email')"
                        />
                        <p v-if="company.email_from_contact" class="-mt-2 text-xs text-muted-500">Почта основного контакта ({{ company.email_from_contact }}); сохранится как почта компании.</p>
                        <ul class="flex flex-col gap-3">
                            <li
                                v-for="(filler, idx) in company.fillers"
                                :key="filler.id"
                                class="flex items-end gap-2"
                            >
                                <!-- <input
                                    type="hidden"
                                    name="fillers"
                                    :value="filler.id"
                                >
                                <input
                                    type="hidden"
                                    :name="`fillers.${filler.id}.${idx}.tempId`"
                                    :value="filler.tempId"
                                >
                                <input
                                    v-if="filler.new"
                                    type="hidden"
                                    :name="`fillers.${filler.id}.${idx}.new`"
                                    value="new"
                                > -->
                                <BaseInput
                                    v-model="filler.value"
                                    :classes="{
                                        wrapper: 'w-full',
                                        inputWrapper: 'flex gap-2',
                                    }"
                                    :label="filler.field"
                                    :name="`fillers.${filler.id}.${idx}`"
                                    :required="filler.is_required"
                                    :error="errors[filler.tempId]"
                                    @input="
                                        onChange(filler.tempId, filler.value)
                                    "
                                />
                            </li>
                        </ul>
                        <BaseCheckbox
                            v-model="company.is_old"
                            rounded="sm"
                            label="Старый клиент"
                            name="is_old"
                        />
                    </section>
                    <!--  REQUISITES: a tab of their own, optional; later they come from the 1С accounting -->
                    <section
                        v-if="activeValue === 'requisites'"
                        class="max-w-sm flex flex-col gap-3"
                    >
                        <p class="text-xs text-muted-500">
                            Реквизиты юрлица ({{ requisitesSummary }}). Необязательные поля; планируется заполнять их из 1С-бухгалтерии.
                            Распознавание карточки предприятия на вкладке «Общее» заполняет их тоже.
                        </p>
                        <BaseInput
                            v-for="field in requisiteFields"
                            :key="field.key"
                            v-model="company[field.key]"
                            type="text"
                            :label="field.label"
                            :name="field.key"
                            :placeholder="field.placeholder"
                            :icon="field.icon"
                            :inputmode="field.digits ? 'numeric' : undefined"
                            :loading="companyLoading"
                            :error="recognitionWarning(field.key)"
                        />
                    </section>
                    <!--  CONTACTS  -->
                    <section v-if="activeValue === 'contacts'">
                        <CtrAgentForm />
                    </section>
                    <!--  DEALS: its own and its contacts'  -->
                    <CompanyDeals
                        v-if="activeValue === 'deals'"
                        :company-id="company.id"
                    />
                    <!--  SETTINGS  -->
                    <!--  kept alive, so the open field and the ids of new fields survive a tab switch  -->
                    <KeepAlive>
                        <CompanyFillersSettings v-if="activeValue === 'settings'" />
                    </KeepAlive>
                    <!--  Files, Reconrdings  -->
                    <CompanySources
                        :list="activeTab"
                        :company="company"
                        :company-loading="companyLoading"
                    />
                </template>
            </BaseTabs>

            <!--  ACTIONS  -->
            <div class="flex flex-col gap-2 mt-10">
                <Can
                    I="delete"
                    a="Company"
                >
                    <BaseButton
                        v-if="company.id"
                        color="danger"
                        :loading="isLoadingMap.delete"
                        :disabled="isLoadingMap.delete"
                        @click="onDelete"
                    >
                        Удалить компанию
                    </BaseButton>
                </Can>
                <Can
                    v-if="!companyLoading"
                    :I="company.id ? 'update' : 'create'"
                    a="Company"
                >
                    <BaseButton
                        color="primary"
                        type="submit"
                        :disabled="isLoadingMap.save"
                        :loading="isLoadingMap.save"
                    >
                        {{ isAdd ? "Добавить компанию" : "Сохранить компанию" }}
                    </BaseButton>
                </Can>
            </div>
        </form>
        <CompanyFeed :company="company" />
    </div>
</template>

<script lang="ts" setup>
import { Can } from "@casl/vue";

import CardRecognition, { type RecognitionResult } from "~/components/company/CardRecognition.vue";
import CompanyDeals from "~/components/company/CompanyDeals.vue";
import CompanyFeed from "~/components/company/CompanyFeed.vue";
import CompanyFillersSettings from "~/components/company/CompanyFillersSettings.vue";
import CompanySources from "~/components/company/CompanySources.vue";
import CtrAgentForm from "~/components/company/CtrAgentForm.vue";
import BaseCheckbox from "~/components/form/BaseCheckbox.vue";
import { useAsync } from "~/composables/useAsync";
import { useValidation } from "~/composables/useValidation";
import type { FillersCreate } from "~/types/filler";
import { type Company, type User,UserRole } from "~/types/user";
import {
    required,
    type Schema,
    validPhone,
} from "~/utils/validation";

const route = useRoute();

// CtrAgents store
const ctrAgentsStore = useCtrAgentsStore();
const { addCtrAgent, applyCtrAgents, getCtrAgentsDTO, $reset } = ctrAgentsStore;

// Fillers store
const fillersStore = useFillersStore();
const { fetchFillers } = fillersStore;
const { fillers } = storeToRefs(fillersStore);

const isAdd = route.params.id === "new";

const toast = useToast("GlobalToast");
const companiesService = useService("companies", { auth: true });
const userService = useService("users", { auth: true });
const fillersService = useService("fillers", { auth: true });

const activeTab = ref("general");

const {
    data: company,
    run: runCompany,
    isLoading: companyLoading,
} = useAsync<Company>({});

const { runWithId, isLoadingMap } = useAsync();

const schema: Schema<string> = {
    name: [required("Обязательное поле")],
    phone: [validPhone("Неверный номер телефона")],
};

const { onChange, validate, errors } = useValidation(schema);

const companyFillersDTO = computed(() => {
    return company.value.fillers.filter((f) => f.value);
});

// ---------------------------------------------------------------- requisites + card recognition
type RequisiteKey = "inn" | "legal_address" | "bank_account" | "bank_name" | "mfo" | "oked" | "director";
const requisiteFields: { key: RequisiteKey; label: string; placeholder: string; icon: string; digits?: boolean }[] = [
    { key: "inn", label: "ИНН", placeholder: "пр.: 305123456", icon: "ph:identification-card", digits: true },
    { key: "legal_address", label: "Юридический адрес", placeholder: "пр.: г. Ташкент, ул. …", icon: "ph:map-pin" },
    { key: "bank_account", label: "Расчётный счёт", placeholder: "20 цифр", icon: "ph:bank", digits: true },
    { key: "bank_name", label: "Банк", placeholder: "пр.: АКБ …", icon: "ph:bank" },
    { key: "mfo", label: "МФО", placeholder: "5 цифр", icon: "ph:hash", digits: true },
    { key: "oked", label: "ОКЭД", placeholder: "5 цифр", icon: "ph:hash", digits: true },
    { key: "director", label: "Директор", placeholder: "ФИО", icon: "ph:user" },
];

const requisitesFilled = computed(() => requisiteFields.filter((f) => String((company.value as any)?.[f.key] ?? "").trim()).length);
const requisitesSummary = computed(() => requisitesFilled.value ? `заполнено ${requisitesFilled.value} из ${requisiteFields.length}` : "не заполнены");

/** Warnings of the last recognition, by form field name ("inn", "email", …). */
const recognitionWarnings = ref<Record<string, string>>({});
function recognitionWarning(key: string) {
    return recognitionWarnings.value[key] || undefined;
}

/**
 * Fill the form from a recognized card. Only empty fields are filled, so an
 * existing company is never overwritten silently; the user saves explicitly.
 */
function onRecognized(data: RecognitionResult, done: (filled: number, skipped: number) => void) {
    let filled = 0;
    let skipped = 0;
    const target = company.value as Record<string, any>;
    for (const [key, value] of Object.entries(data.company)) {
        if (!value) continue;
        if (target[key]) {
            if (String(target[key]).trim() !== value) skipped++;
            continue;
        }
        target[key] = value;
        filled++;
        if (key === "name" || key === "phone") onChange(key, value);
    }
    // A business card of a person carries only that person's phone and email: without the
    // organisation's own ones they become the company's general contacts too, so the card
    // is not left without a phone (the contact keeps them as well).
    const first = data.contacts.find((p) => p.phone || p.email);
    for (const key of ["phone", "email"] as const) {
        if (!target[key] && first?.[key]) {
            target[key] = first[key];
            filled++;
            if (key === "phone") onChange(key, first[key]!);
        }
    }

    // People from the card become contacts of the company
    const positionFiller = fillers.value.user?.find((f) => f.field.trim().toLowerCase() === "должность");
    for (const person of data.contacts) {
        if (!person.full_name) continue;
        const same = ctrAgentsStore.ctrAgents.find(
            (a) => (person.email && a.email === person.email) || (person.phone && a.phone === person.phone),
        );
        if (same) continue;
        let agent = ctrAgentsStore.ctrAgents.find((a) => !a.id && !a.username && !a.email && !a.phone);
        if (!agent) {
            addCtrAgent();
            agent = ctrAgentsStore.ctrAgents[ctrAgentsStore.ctrAgents.length - 1];
        }
        agent.username = person.full_name;
        agent.email = person.email ?? undefined;
        agent.phone = person.phone ?? undefined;
        if (person.position && positionFiller) {
            const f = agent.fillers.find((x) => x.id === positionFiller.id);
            if (f) f.value = person.position;
        }
        filled++;
    }

    recognitionWarnings.value = {};
    for (const w of data.warnings) {
        const m = /^company\.(\w+)$/.exec(w.field);
        if (m) recognitionWarnings.value[m[1]] = w.message;
    }
    done(filled, skipped);
}

async function onSubmit() {
    const { id, name, phone, email, is_old = false } = company.value;
    // Requisites: empty strings are sent as "" and stored as NULL by the API
    const requisites = Object.fromEntries(
        requisiteFields.map((f) => [f.key, (company.value[f.key] ?? "").toString().trim()])
    );

    const fillersCreate: FillersCreate[] = [];

    // const fieldsMap: Record<string, string> = {};

    // for (const key in companyFillers) {
    //     const filler = companyFillers[key];
    //     if (!filler.value) continue;
    //     if (filler.new)
    //         fillersCreate.push({ filler_id: filler.id, value: filler.value });
    //     else companyFillers.push({ filler_id: filler.id, value: filler.value });
    //     fieldsMap[filler.tempId] = filler.value;
    // }

    companyFillersDTO.value.forEach((f) => {
        if (f.new) {
            fillersCreate.push({ filler_id: f.id, value: f.value });
        }
        f.filler_id = f.id;
    });

    const validationResult = validate({
        name,
        phone,
        email,
        // ...fieldsMap,
    });

    if (!validationResult.valid) return;

    let promise;
    if (id)
        promise = companiesService
            .patch(id, {
                name,
                phone,
                email,
                is_old,
                ...requisites,
                fillers: companyFillersDTO.value,
                fillers_create: fillersCreate,
                users: getCtrAgentsDTO(),
                primary_contact_id: ctrAgentsStore.primaryContactId ?? null,
            })
            .exec();
    else
        promise = companiesService
            .create({
                name,
                phone,
                email,
                ...requisites,
                fillers: companyFillersDTO.value,
                fillers_create: fillersCreate,
                is_old,
                users: getCtrAgentsDTO(),
            })
            .exec();

    const result = await promiseResult(runWithId(promise, "save"));

    if (!result.ok) {
        // Handle if ctr_agents is not an added
        if (result.error.message.includes("ctr_agents must be an array")) {
            activeTab.value = "contacts";

            return toast.show({
                message: "Добавьте хотя бы одного контакта",
                type: "error",
                timeout: 3000,
            });
        }

        // Handle other errors
        return toast.show({
            message: result.error.message,
            type: "error",
            timeout: 3000,
        });
    }
    navigateTo("/lists/companies");
}

async function onDelete() {
    const result = await promiseResult(
        runWithId(companiesService.remove(company.value.id).exec(), "delete")
    );
    if (!result.ok)
        return toast.show({
            message: result.error.message,
            type: "error",
            timeout: 3000,
        });
    navigateTo("/lists/companies");
}

// TODO: fix validation
// watch([fillers, company], () => {
//     for (const filler of fillers.value.company || []) {
//         if (
//             company.value.fillers?.some(
//                 (cf) => cf.filler.id === filler.id
//             )
//         )
//             continue;
//         if (!company.value.fillers) company.value.fillers = [];
//         let fillerValue = {
//             id: filler.id,
//             value: "",
//             filler,
//             new: false,
//             created_at: new Date().toISOString(),
//             tempId: Math.random().toString(32).slice(2),
//         };

//         company.value.fillers.push(fillerValue);
//         if (filler.is_required)
//             schema[fillerValue.tempId] = [required("Обязательное поле")];
//     }

//     for (const filler of fillers.value.user || []) {
//         for (const agent of company.value.ctr_agents ?? []) {
//             if (agent.fillers?.some((af) => af.filler.id === filler.id))
//                 continue;
//             if (!agent.fillers) agent.fillers = [];
//             let fillerValue = {
//                 filler_id: filler.id,
//                 value: "",
//                 filler,
//                 new: true,
//                 created_at: new Date().toISOString(),
//                 tempId: Math.random().toString(32).slice(2),
//             };

//             agent.fillers.push(fillerValue);
//             if (filler.is_required)
//                 schema[fillerValue.tempId] = [required("Обязательное поле")];
//         }
//     }
// });

const user = useState<User>("user");

const tabs = computed(() => {
    const generalTabs = [
        { label: "Общее", value: "general", order: 1 },
        { label: "Реквизиты", value: "requisites", order: 2 },
        { label: "Контакты", value: "contacts", order: 2.5 },
    ];


    if (user.value.role == UserRole.Admin) {
        generalTabs.push({ label: "Настройка", value: "settings", order: 5 });
    }

    if (!isAdd) {
        generalTabs.push({ label: "Сделки", value: "deals", order: 2.7 });
        generalTabs.push({ label: "Файлы", value: "files", order: 3 });
        generalTabs.push({ label: "Звонки", value: "recordings", order: 4 });
    }

    return generalTabs.sort((a, b) => a.order - b.order);
});

const applyCompanyFillers = () => {
    company.value.fillers = fillers.value.company.map((filler) => ({
        ...filler,
        value:
            company.value.fillers?.find((cf) => cf.id === filler.id)?.value ||
            undefined,
    }));
};

onMounted(async () => {
    // Fetch fillers
    await fetchFillers(fillersService.find({ target: "company" }).exec());

    // Fetch company
    if (route.params.id !== "new") {
        await runCompany(
            companiesService.get(route.params.id as string).exec()
        );
    }

    // Add default user in creating new company
    if (isAdd) {
        $reset();
        addCtrAgent();
    } else {
        applyCtrAgents(company.value.users);
        ctrAgentsStore.primaryContactId = (company.value as any).primary_contact_id ?? null;
    }

    applyCompanyFillers();
});

definePageMeta({
    authRoute: true,
    layout: "no-min-height",
    verbose: "Редактировать компанию",
});

useHead({
    title: "Редактировать компанию",
});
</script>
