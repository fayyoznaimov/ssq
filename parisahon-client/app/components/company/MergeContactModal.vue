<template>
    <!-- «Объединить контакты»: the same client entered twice (a Telegram chat without a phone, then
         WhatsApp; a typo). The chosen contact is merged into this one (POST /users/:id/merge) and deleted. -->
    <Modal :id="props.id">
        <template #header>
            <h2 class="text-lg text-muted-900 dark:text-white">
                Объединить контакты
            </h2>
        </template>
        <div class="flex flex-col gap-4">
            <p class="text-sm text-muted-600 dark:text-muted-300">
                Найдите второй контакт этого же клиента. Он будет присоединён к «{{ props.contact.username }}».
            </p>
            <BaseInput
                v-model="query"
                icon="ph:magnifying-glass"
                placeholder="Имя, телефон или почта"
                name="merge-search"
                @input="onSearch"
            />
            <p
                v-if="searching"
                class="text-xs text-muted-500"
            >
                Ищем…
            </p>
            <ul
                v-else-if="candidates.length"
                class="flex max-h-64 flex-col gap-1 overflow-y-auto"
            >
                <li
                    v-for="c in candidates"
                    :key="c.id"
                >
                    <button
                        type="button"
                        class="w-full rounded-md border px-3 py-2 text-left text-sm transition-colors"
                        :class="selected?.id === c.id
                            ? 'border-primary-500 bg-primary-500/10'
                            : 'border-muted-200 hover:bg-muted-100 dark:border-muted-700 dark:hover:bg-muted-900'"
                        @click="selected = c"
                    >
                        <span class="font-medium text-muted-800 dark:text-white">{{ c.name }}</span>
                        <span class="block text-xs text-muted-500 dark:text-muted-400">
                            {{ [c.phones?.[0], c.emails?.[0], c.company?.name ?? "без компании"].filter(Boolean).join(" · ") }}
                        </span>
                    </button>
                </li>
            </ul>
            <p
                v-else-if="query.trim().length >= 2"
                class="text-xs text-muted-500"
            >
                Ничего не нашлось
            </p>
            <BaseMessage
                v-if="selected"
                type="warning"
                :closable="false"
            >
                Сделки, история, задачи, письма и Telegram / WhatsApp контакта «{{ selected.name }}» перейдут к
                «{{ props.contact.username }}», как и его телефон, почта и компания, если их здесь нет.
                Контакт «{{ selected.name }}» будет удалён. Отменить объединение нельзя.
            </BaseMessage>
        </div>
        <template #footer>
            <div class="flex gap-2">
                <BaseButton
                    color="primary"
                    variant="solid"
                    :disabled="!selected || busy"
                    :loading="busy"
                    @click="merge"
                >
                    Объединить
                </BaseButton>
                <BaseButton @click="modal.close">
                    Отменить
                </BaseButton>
            </div>
        </template>
    </Modal>
</template>

<script lang="ts" setup>
import Modal from "~/components/common/Modal.vue";

type Candidate = {
    id: number;
    name: string;
    phones?: string[];
    emails?: string[];
    company?: { id: number; name: string } | null;
};

const props = defineProps<{ id: string; contact: { id?: number; username?: string } }>();
const emit = defineEmits<{ (e: "merged", result: { id: number; merged_id: number; deals: number }): void }>();

const modal = useModal(props.id);
const toast = useToast("GlobalToast");
const contactsService = useService("contacts", { auth: true });
const userService = useService("users", { auth: true });

const query = ref("");
const candidates = ref<Candidate[]>([]);
const selected = ref<Candidate | null>(null);
const searching = ref(false);
const busy = ref(false);
let requestNo = 0;

const onSearch = debounce(async () => {
    const text = query.value.trim();
    selected.value = null;
    if (text.length < 2) {
        candidates.value = [];
        return;
    }
    const mine = ++requestNo;
    searching.value = true;
    const result = await promiseResult(contactsService.find({ q: text, role: "ctr_agent", limit: 20 }).exec());
    if (mine !== requestNo) return;
    searching.value = false;
    const rows = result.ok ? ((result.value as any)?.data ?? []) : [];
    candidates.value = rows.filter((row: any) => row.type === "ctr_agent" && row.id !== props.contact.id);
}, 400);

async function merge() {
    if (!selected.value || !props.contact.id) return;
    busy.value = true;
    const result = await promiseResult(
        userService.post(`${props.contact.id}/merge`, { from_id: selected.value.id }).exec(),
    );
    busy.value = false;
    if (!result.ok) return toast.show({ message: result.error.message, type: "error", timeout: 4000 });
    toast.show({ message: `Контакт «${selected.value.name}» присоединён`, type: "success", timeout: 3000 });
    emit("merged", result.value as any);
    query.value = "";
    candidates.value = [];
    selected.value = null;
    modal.close();
}
</script>
