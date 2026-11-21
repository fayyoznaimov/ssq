<template>
    <div class="rounded-md border border-dashed border-muted-300 dark:border-muted-700 p-3 flex flex-col gap-2">
        <label
            class="flex items-center gap-2 cursor-pointer text-sm"
            :class="{ 'opacity-60 pointer-events-none': loading }"
        >
            <Icon
                :name="loading ? 'ph:circle-notch' : 'ph:camera'"
                class="size-5 shrink-0 text-primary-200"
                :class="{ 'animate-spin': loading }"
            />
            <span>
                {{ loading ? "Распознаём карточку…" : "Заполнить по фото карточки или визитки" }}
            </span>
            <input
                ref="fileInput"
                type="file"
                class="hidden"
                accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                capture="environment"
                @change="onFile"
            >
        </label>
        <p class="text-xs text-muted-400">
            Фото или PDF до 10 МБ. Поля заполнятся автоматически, сохранение — только после вашей проверки.
        </p>

        <BaseMessage
            v-if="error"
            type="danger"
            :closable="false"
        >
            {{ error }}
        </BaseMessage>

        <template v-if="result">
            <p class="text-sm">
                {{ summary }}
            </p>
            <ul
                v-if="result.warnings.length"
                class="text-xs text-amber-500 list-disc ps-4"
            >
                <li
                    v-for="w in result.warnings"
                    :key="w.field + w.message"
                >
                    {{ fieldLabel(w.field) }}: {{ w.message }}
                </li>
            </ul>
            <div
                v-if="result.duplicates.companies.length || result.duplicates.contacts.length"
                class="text-xs flex flex-col gap-1"
            >
                <span class="text-red-500">Похоже, это уже есть в CRM:</span>
                <NuxtLink
                    v-for="c in result.duplicates.companies"
                    :key="'c' + c.id"
                    :to="`/lists/companies/${c.id}`"
                    class="underline"
                >
                    компания «{{ c.name }}» ({{ c.match === "inn" ? "тот же ИНН" : "похожее название" }})
                </NuxtLink>
                <NuxtLink
                    v-for="u in result.duplicates.contacts"
                    :key="'u' + u.id"
                    :to="`/lists/contacts/${u.id}`"
                    class="underline"
                >
                    контакт «{{ u.username }}» ({{ u.match === "email" ? "тот же email" : "тот же телефон" }})
                </NuxtLink>
            </div>
        </template>
    </div>
</template>

<script lang="ts" setup>
export type RecognitionResult = {
    document_type: "company_card" | "business_card" | "other";
    company: {
        name: string | null;
        inn: string | null;
        legal_address: string | null;
        bank_account: string | null;
        bank_name: string | null;
        mfo: string | null;
        oked: string | null;
        director: string | null;
        phone: string | null;
        email: string | null;
    };
    contacts: { full_name: string | null; position: string | null; phone: string | null; email: string | null }[];
    unclear_fields: string[];
    notes: string | null;
    warnings: { field: string; message: string }[];
    duplicates: {
        companies: { id: number; name: string; inn: string | null; match: "inn" | "name" }[];
        contacts: { id: number; username: string; email: string | null; phone: string | null; company_id: number | null; match: "email" | "phone" }[];
    };
};

const props = defineProps<{
    /** Company being edited: it is not a duplicate of itself. */
    companyId?: number;
}>();

const emit = defineEmits<{
    /** Returns how many fields were filled, so the summary can say it. */
    (e: "recognized", value: RecognitionResult, done: (filled: number, skipped: number) => void): void;
}>();

const LABELS: Record<string, string> = {
    "company.name": "Название",
    "company.inn": "ИНН",
    "company.legal_address": "Юр. адрес",
    "company.bank_account": "Расчётный счёт",
    "company.bank_name": "Банк",
    "company.mfo": "МФО",
    "company.oked": "ОКЭД",
    "company.director": "Директор",
    "company.phone": "Телефон",
    "company.email": "Email",
    document_type: "Документ",
};

function fieldLabel(field: string) {
    const contact = /^contacts\.(\d+)\.(\w+)$/.exec(field);
    if (contact) return `Контакт ${Number(contact[1]) + 1}, ${contact[2]}`;
    return LABELS[field] ?? field;
}

const companiesService = useService("companies", { auth: true });
const fileInput = ref<HTMLInputElement>();
const loading = ref(false);
const error = ref("");
const result = ref<RecognitionResult | null>(null);
const summary = ref("");

async function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
        error.value = "Файл больше 10 МБ";
        return;
    }

    loading.value = true;
    error.value = "";
    result.value = null;

    const body = new FormData();
    body.append("file", file);
    try {
        const data = (await companiesService.upload("recognize", body)) as RecognitionResult;
        if (props.companyId) {
            data.duplicates.companies = data.duplicates.companies.filter((c) => c.id !== props.companyId);
            data.duplicates.contacts = data.duplicates.contacts.filter((u) => u.company_id !== props.companyId);
        }
        result.value = data;
        emit("recognized", data, (filled, skipped) => {
            const kept = skipped ? ` Уже заполненные поля с другим значением не тронуты: ${skipped}.` : "";
            summary.value = filled
                ? `Заполнено полей: ${filled}.${kept} Проверьте и сохраните.`
                : `Новых данных нет.${kept}`;
            if (data.notes) summary.value += ` ${data.notes}`;
        });
    } catch (err: any) {
        const message = Array.isArray(err?.message) ? err.message.join("; ") : err?.message;
        error.value = message || "Не удалось распознать файл";
    } finally {
        loading.value = false;
        // allow choosing the same file again
        if (fileInput.value) fileInput.value.value = "";
    }
}
</script>
