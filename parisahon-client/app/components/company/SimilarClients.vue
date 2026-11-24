<script setup lang="ts">
/**
 * "Похоже, такой клиент уже есть": asks GET /companies/similar while the user types the name,
 * phone, e-mail or INN of a company or contact, and shows matches with the reasons in plain words,
 * plus hints about the phone format and e-mail typos. It only informs: saving is never blocked.
 * - It asks when a field CHANGES (no `immediate`): mount it with the loaded record, and a saved card
 *   does not warn about itself on every opening.
 * - Matches only by the e-mail domain are folded into one line.
 * - «Это другой клиент» is remembered for the record (localStorage), the same matches are not shown again.
 */
const props = withDefaults(defineProps<{
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    inn?: string | null;
    excludeCompanyId?: number | null;
    excludeContactId?: number | null;
}>(), {
    name: null,
    phone: null,
    email: null,
    inn: null,
    excludeCompanyId: null,
    excludeContactId: null,
});

interface SimilarMatch {
    kind: 'company' | 'contact';
    id: number;
    name: string;
    company_name: string | null;
    level: 'same' | 'possible';
    reasons: string[];
    agent_name: string | null;
    last_deal_at: string | null;
    // false: another manager's client the user may not open — shown without a link
    visible?: boolean;
}

const similarService = useService('companies/similar', { auth: true });
const matches = ref<SimilarMatch[]>([]);
const hints = ref<{ phone: string | null; email: string | null; inn: string | null }>({ phone: null, email: null, inn: null });
const dismissed = ref(false);
const showDomain = ref(false);

// «Это другой клиент» of a saved record: the matches the user has looked at and rejected
const storageKey = computed(() => {
    if (props.excludeCompanyId) return `similar-dismissed:company-${props.excludeCompanyId}`;
    if (props.excludeContactId) return `similar-dismissed:contact-${props.excludeContactId}`;
    return null;
});
function readDismissed(): string[] {
    if (!storageKey.value || typeof localStorage === 'undefined') return [];
    try {
        const list = JSON.parse(localStorage.getItem(storageKey.value) ?? '[]');
        return Array.isArray(list) ? list.map(String) : [];
    } catch {
        return [];
    }
}
const matchKey = (m: SimilarMatch) => `${m.kind}-${m.id}`;
function dismiss() {
    dismissed.value = true;
    if (!storageKey.value || typeof localStorage === 'undefined') return;
    const keys = new Set([...readDismissed(), ...matches.value.map(matchKey)]);
    try {
        localStorage.setItem(storageKey.value, JSON.stringify([...keys].slice(-200)));
    } catch {
        // storage full or off: remembered for this page only
    }
}
let timer: ReturnType<typeof setTimeout> | null = null;
let requestNo = 0;

function query() {
    const q: Record<string, any> = {};
    if (props.name && props.name.trim().length >= 3) q.name = props.name.trim();
    if (props.phone && props.phone.replace(/\D/g, '').length >= 7) q.phone = props.phone;
    if (props.email && props.email.includes('@')) q.email = props.email.trim();
    if (props.inn && props.inn.replace(/\D/g, '').length >= 6) q.inn = props.inn;
    if (props.excludeCompanyId) q.exclude_company_id = props.excludeCompanyId;
    if (props.excludeContactId) q.exclude_contact_id = props.excludeContactId;
    return q;
}

watch(
    () => [props.name, props.phone, props.email, props.inn],
    () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
            const q = query();
            const searchable = ['name', 'phone', 'email', 'inn'].some((k) => k in q);
            if (!searchable) {
                matches.value = [];
                hints.value = { phone: null, email: null, inn: null };
                return;
            }
            const mine = ++requestNo;
            const result = await promiseResult(similarService.find(q).exec());
            if (mine !== requestNo || !result.ok) return;
            const data: any = result.value;
            const rejected = new Set(readDismissed());
            matches.value = (data.matches ?? []).filter((m: SimilarMatch) => !rejected.has(matchKey(m)));
            hints.value = data.hints ?? { phone: null, email: null, inn: null };
            dismissed.value = false;
        }, 500);
    },
);

onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
});

// only «Почта на том же домене …»: weak, often a dozen of them — folded into one line
const domainOnly = (m: SimilarMatch) => m.level === 'possible' && m.reasons.length > 0 && m.reasons.every((r) => r.startsWith('Почта на том же домене'));
const sure = computed(() => matches.value.filter((m) => m.level === 'same'));
const maybe = computed(() => matches.value.filter((m) => m.level === 'possible' && !domainOnly(m)));
const sameDomain = computed(() => matches.value.filter(domainOnly));
const shown = computed(() => [...sure.value, ...maybe.value, ...(showDomain.value ? sameDomain.value : [])]);

function linkOf(m: SimilarMatch) {
    return m.kind === 'company' ? `/lists/companies/${m.id}` : `/lists/contacts/${m.id}`;
}

function since(date: string | null) {
    if (!date) return '';
    return `, последняя сделка ${new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;
}
</script>

<template>
    <div class="flex flex-col gap-3">
        <p v-if="hints.phone" class="text-xs text-orange-500">{{ hints.phone }}</p>
        <p v-if="hints.email" class="text-xs text-orange-500">{{ hints.email }}</p>
        <p v-if="hints.inn" class="text-xs text-muted-500 dark:text-muted-400">{{ hints.inn }}</p>
        <BaseCard
            v-if="matches.length && !dismissed"
            class="flex flex-col gap-3 p-4"
            :class="sure.length ? '!border-orange-400' : ''"
        >
            <BaseHeading as="h4" size="sm" weight="semibold" :class="sure.length ? 'text-orange-500' : 'text-muted-800 dark:text-white'">
                {{ sure.length ? 'Похоже, такой клиент уже есть' : 'Есть похожие записи' }}
            </BaseHeading>
            <ul class="flex flex-col gap-3">
                <li v-for="m of shown" :key="`${m.kind}-${m.id}`" class="flex flex-col gap-1 rounded-md bg-muted-100 p-3 dark:bg-muted-900">
                    <div class="flex flex-wrap items-baseline justify-between gap-2">
                        <NuxtLink v-if="m.visible !== false" :to="linkOf(m)" target="_blank" class="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300">
                            {{ m.name }}
                        </NuxtLink>
                        <span v-else class="font-medium text-muted-800 dark:text-muted-100" title="Клиент другого менеджера: карточка вам не доступна">
                            {{ m.name }}
                        </span>
                        <span class="text-xs font-semibold" :class="m.level === 'same' ? 'text-orange-500' : 'text-muted-500'">
                            {{ m.level === 'same' ? 'почти наверняка тот же' : 'возможно, другой' }}
                        </span>
                    </div>
                    <span class="text-xs text-muted-500 dark:text-muted-400">
                        {{ m.kind === 'company' ? 'Компания' : `Контакт${m.company_name ? ` из «${m.company_name}»` : ''}` }}.
                        {{ m.reasons.join('. ') }}.
                        <template v-if="m.agent_name">Ведёт {{ m.agent_name }}{{ since(m.last_deal_at) }}.</template>
                    </span>
                </li>
            </ul>
            <button
                v-if="sameDomain.length && !showDomain"
                type="button"
                class="self-start text-xs text-muted-500 underline underline-offset-2 hover:text-primary-500"
                @click="showDomain = true"
            >
                {{ shown.length ? 'Ещё' : 'Записей' }} с почтой на том же домене: {{ sameDomain.length }} — показать
            </button>
            <div>
                <BaseButton size="sm" variant="pastel" @click="dismiss">Это другой клиент</BaseButton>
            </div>
        </BaseCard>
    </div>
</template>
