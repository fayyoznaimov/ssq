<template>
    <div class="flex flex-col gap-4 py-4 text-sm leading-relaxed text-muted-700 dark:text-muted-200">
        <div v-if="!data" class="flex flex-col gap-3">
            <BasePlaceload class="h-5 w-2/3 rounded-md" />
            <BasePlaceload class="h-16 w-full rounded-md" />
            <BasePlaceload class="h-16 w-full rounded-md" />
        </div>

        <template v-else-if="data.enabled">
            <p v-if="notice" class="flex items-start gap-2 rounded-md px-3 py-2" :class="notice.warn ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200' : 'bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-200'">
                <Icon :name="notice.warn ? 'ph:warning' : 'ph:hourglass-medium'" class="mt-0.5 size-4 shrink-0" />
                <span>{{ notice.text }}</span>
            </p>

            <!-- «Сводка сделки» -->
            <section v-if="data.features.summary" :class="card">
                <header class="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 :class="heading">Сводка</h3>
                    <BaseButton
                        size="sm"
                        variant="pastel"
                        color="primary"
                        :loading="summarizing"
                        :disabled="summarizing || !!data.paused_until"
                        @click="onSummary"
                    >
                        <Icon name="ph:sparkle" class="me-1 size-4" />
                        {{ summary?.data ? 'Обновить' : 'Сделать сводку' }}
                    </BaseButton>
                </header>
                <template v-if="summary?.data">
                    <dl class="flex flex-col gap-3">
                        <div v-if="summary.data.client_wants">
                            <dt :class="label">Что хочет клиент</dt>
                            <dd>{{ summary.data.client_wants }}</dd>
                            <AiRefs :ids="summary.data.client_wants_refs" :refs="data.refs" />
                        </div>
                        <div v-if="summary.data.promised.length">
                            <dt :class="label">Обещано</dt>
                            <dd>
                                <ul class="flex flex-col gap-1">
                                    <li v-for="(p, i) in summary.data.promised" :key="'sp' + i" class="flex gap-1.5">
                                        <span class="shrink-0 font-medium">{{ whoLabel(p.who) }}:</span>
                                        <span>{{ p.what || p.text }}<template v-if="p.due"> — до {{ dueStamp(p.due) }}</template></span>
                                    </li>
                                </ul>
                            </dd>
                        </div>
                        <div v-if="summary.data.open_questions.length">
                            <dt :class="label">Открытые вопросы</dt>
                            <dd>
                                <ul class="list-disc ps-5">
                                    <li v-for="(q, i) in summary.data.open_questions" :key="'sq' + i">{{ q.text }}</li>
                                </ul>
                            </dd>
                        </div>
                        <div v-if="summary.data.next_step">
                            <dt :class="label">Следующий шаг</dt>
                            <dd class="font-medium text-muted-900 dark:text-white">{{ summary.data.next_step }}</dd>
                            <AiRefs :ids="summary.data.next_step_refs" :refs="data.refs" />
                        </div>
                    </dl>
                    <p class="mt-2 text-xs text-muted-400">
                        {{ summary.made_at ? 'Сделана ' + stamp(summary.made_at) : '' }}<template v-if="updating"> · готовлю новую…</template><template v-else-if="!summary.fresh"> · переписка с тех пор изменилась, нажмите «Обновить»</template>
                    </p>
                </template>
                <p v-else-if="updating" class="text-muted-500 dark:text-muted-400">
                    Готовлю сводку, это займёт до минуты…
                </p>
                <p v-else-if="summary?.error" class="text-muted-500 dark:text-muted-400">{{ summary.error }}</p>
                <p v-else class="text-muted-500 dark:text-muted-400">
                    Что хочет клиент, что обещано, открытые вопросы и следующий шаг — по переписке сделки.
                </p>
            </section>

            <!-- «Вопрос без ответа» -->
            <section v-if="data.questions.length" :class="card">
                <h3 :class="[heading, 'mb-2']">Вопросы клиента без ответа · {{ data.questions.length }}</h3>
                <ul class="flex flex-col gap-3">
                    <li v-for="q in data.questions" :key="q.id" class="flex items-start gap-2">
                        <Icon name="ph:question" class="mt-0.5 size-4 shrink-0 text-amber-500" />
                        <div class="min-w-0 flex-1">
                            <p class="break-words text-muted-900 dark:text-white">{{ q.text }}</p>
                            <AiRefs :ids="[q.event_id]" :refs="data.refs" />
                            <p v-if="q.task_id && !q.task_closed" class="mt-0.5 text-xs text-primary-600 dark:text-primary-300">Поставлена задача ответить</p>
                        </div>
                        <BaseButton
                            v-if="data.can_update"
                            size="sm"
                            variant="pastel"
                            :loading="dismissing === q.id"
                            :disabled="dismissing !== null"
                            title="Ответ не нужен или клиенту уже ответили"
                            @click="onDismiss(q.id)"
                        >
                            Снять
                        </BaseButton>
                    </li>
                </ul>
            </section>

            <!-- «Обещания» -->
            <section v-if="data.promises.length" :class="card">
                <h3 :class="[heading, 'mb-2']">Обещания · {{ data.promises.length }}</h3>
                <ul class="flex flex-col gap-3">
                    <li v-for="p in data.promises" :key="p.id" class="flex items-start gap-2">
                        <Icon :name="p.who === 'client' ? 'ph:user' : 'ph:handshake'" class="mt-0.5 size-4 shrink-0" :class="p.who === 'client' ? 'text-muted-400' : 'text-primary-500'" />
                        <div class="min-w-0 flex-1">
                            <p class="break-words">
                                <span class="font-medium">{{ whoLabel(p.who) }}:</span>
                                <span class="text-muted-900 dark:text-white"> {{ p.text }}</span>
                            </p>
                            <p v-if="p.due_at" class="text-xs" :class="overdue(p) ? 'text-danger-500' : 'text-muted-500 dark:text-muted-400'">
                                до {{ p.due_has_time ? stamp(p.due_at) : day(p.due_at) }}{{ overdue(p) ? ' · срок прошёл' : '' }}
                            </p>
                            <AiRefs :ids="[p.event_id]" :refs="data.refs" />
                            <p v-if="p.task_id && !p.task_closed" class="mt-0.5 text-xs text-primary-600 dark:text-primary-300">Есть задача на этот срок</p>
                        </div>
                        <BaseButton
                            v-if="data.can_update"
                            size="sm"
                            variant="pastel"
                            :loading="dismissing === p.id"
                            :disabled="dismissing !== null"
                            title="Обещание выполнено или больше не нужно"
                            @click="onDismiss(p.id)"
                        >
                            Снять
                        </BaseButton>
                    </li>
                </ul>
            </section>

            <!-- order parameters from the conversation -->
            <section v-if="data.order_params.length" :class="card">
                <header class="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 :class="heading">Параметры заказа из переписки</h3>
                    <BaseButton
                        v-if="readyKeys.length > 1"
                        size="sm"
                        variant="pastel"
                        color="primary"
                        :loading="accepting === '*'"
                        :disabled="accepting !== null"
                        @click="onAccept(readyKeys)"
                    >
                        Принять всё
                    </BaseButton>
                </header>
                <ul class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700">
                    <li v-for="p in data.order_params" :key="p.key" class="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
                        <div class="min-w-0 flex-1">
                            <p class="break-words">
                                <span class="text-muted-500 dark:text-muted-400">{{ p.label }}:</span>
                                <span class="font-medium text-muted-900 dark:text-white"> {{ p.value }}</span>
                            </p>
                            <p class="text-xs text-muted-500 dark:text-muted-400">{{ paramNote(p) }}</p>
                        </div>
                        <BaseButton
                            v-if="p.can_accept && !inForm(p)"
                            size="sm"
                            variant="pastel"
                            color="primary"
                            :loading="accepting === p.key"
                            :disabled="accepting !== null"
                            :title="'Записать в поле сделки «' + (p.target?.field ?? '') + '»'"
                            @click="onAccept([p.key])"
                        >
                            Принять
                        </BaseButton>
                        <Icon v-else-if="p.state === 'accepted'" name="ph:check-circle" class="mt-1 size-5 shrink-0 text-success-500" title="Уже в сделке" />
                    </li>
                </ul>
                <p v-if="data.missing_fields.length" class="mt-2 text-xs text-muted-400">
                    Чтобы переносить в сделку {{ data.missing_fields.length > 1 ? 'эти параметры' : 'этот параметр' }}, администратор может добавить
                    {{ data.missing_fields.length > 1 ? 'поля' : 'поле' }} сделки {{ data.missing_fields.map((f) => '«' + f + '»').join(', ') }}
                    (Настройки → Сделки). Заполненные поля ИИ не меняет.
                </p>
            </section>

            <!-- flags of the last 30 days -->
            <section v-if="data.flags.length" :class="card">
                <h3 :class="[heading, 'mb-2']">Обратите внимание</h3>
                <div class="flex flex-wrap gap-2">
                    <span
                        v-for="f in data.flags"
                        :key="f.flag"
                        class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
                        :class="f.flag === 'complaint' || f.flag === 'rude' ? 'bg-danger-100 text-danger-700 dark:bg-danger-500/20 dark:text-danger-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'"
                        :title="'Последний раз ' + stamp(f.last_at)"
                    >
                        {{ f.label }}<template v-if="f.count > 1"> × {{ f.count }}</template>
                    </span>
                </div>
            </section>

            <!-- the last analyses -->
            <details v-if="data.turns.length" :class="card">
                <summary class="cursor-pointer select-none" :class="heading">Последние разборы переписки · {{ data.turns.length }}</summary>
                <ul class="mt-2 flex flex-col gap-2">
                    <li v-for="t in data.turns" :key="t.id" class="flex flex-col">
                        <span class="text-xs text-muted-400">{{ stamp(t.at) }}<template v-if="t.channels.length"> · {{ t.channels.map(channelLabel).join(', ') }}</template><template v-if="t.language && t.language !== 'ru'"> · язык клиента: {{ languageLabel(t.language) }}</template></span>
                        <span>{{ t.summary || '—' }}</span>
                    </li>
                </ul>
            </details>

            <p v-if="isEmpty" class="rounded-md border border-dashed border-muted-300 p-4 text-muted-500 dark:border-muted-600 dark:text-muted-400">
                Здесь появятся вопросы клиента, оставшиеся без ответа, обещания с датами и параметры заказа (размер, граммаж, цвет, количество):
                ИИ разбирает переписку в Telegram, WhatsApp и почте после ответа менеджера.
            </p>

            <p class="text-xs text-muted-400">
                ИИ только подсказывает — сверяйтесь с перепиской.
                <template v-if="data.features.question_tasks || data.features.promise_tasks">
                    Автозадачи «Авто (ИИ)»: {{ autoTasksText }}.
                </template>
            </p>
        </template>

        <p v-else class="text-muted-500 dark:text-muted-400">ИИ-функции CRM выключены администратором.</p>
    </div>
</template>

<script lang="ts" setup>
/**
 * The tab «ИИ» of the deal page: the summary of the deal («Обновить»), the client's questions left
 * without an answer, the promises (both with «Снять»), the order parameters found in the conversation
 * with «Принять» into the empty deal fields of the same name, the flags and the last analyses.
 * The data and the actions come from useDealAi (composables/useDealAi.ts), created by the page.
 * After «Принять» the open form of the deal (`deal`) gets the new values and their row ids, so a later
 * «Сохранить» of the form updates those rows instead of adding second ones.
 */
import moment from 'moment';

import type { AiAccepted, AiItem, AiParam, DealAi } from '~/composables/useDealAi';
import AiRefs from './AiRefs.vue';

const props = defineProps<{ ai: DealAi; deal?: Record<string, any> | null }>();

const { data, summarizing, accepting, dismissing } = props.ai;
const toast = useToast('GlobalToast');

const card = 'rounded-lg border border-muted-200 bg-white p-3 dark:border-muted-700 dark:bg-muted-800';
const heading = 'text-xs font-semibold uppercase tracking-wide text-muted-500 dark:text-muted-400';
const label = 'text-xs text-muted-500 dark:text-muted-400';

const summary = computed(() => data.value?.summary ?? null);
/** a summary for the current conversation is being made (the button, or one asked before) */
const updating = computed(() => summarizing.value || summary.value?.status === 'queued' || summary.value?.status === 'running');

const notice = computed<{ text: string; warn: boolean } | null>(() => {
    const d = data.value;
    if (!d) return null;
    if (d.paused_until) return { text: `ИИ на паузе до ${moment(d.paused_until).format('HH:mm')}: ${d.pause_reason || 'лимит подписки Claude'}`, warn: true };
    if (d.deal_closed) return { text: 'Сделка закрыта: новая переписка не разбирается.', warn: false };
    if (!d.features.turns) return { text: 'Разбор переписки выключен администратором: доступна только сводка.', warn: false };
    if (d.budget_spent) return { text: 'Дневной лимит фонового разбора исчерпан: новые сообщения ИИ разберёт завтра.', warn: true };
    if (d.analysing) return { text: 'ИИ разбирает новые сообщения…', warn: false };
    return null;
});

const isEmpty = computed(() => {
    const d = data.value;
    return !!d && !d.questions.length && !d.promises.length && !d.order_params.length && !d.flags.length && !d.turns.length;
});

const autoTasksText = computed(() => {
    const parts: string[] = [];
    if (data.value?.features.question_tasks) parts.push('вопрос без ответа становится задачей');
    if (data.value?.features.promise_tasks) parts.push('обещание с датой — задачей на этот срок');
    return parts.join(', ');
});

/** the value the open form of the deal has for this field (typed, maybe not saved yet) */
function formValue(p: AiParam): string {
    const rows: any[] = Array.isArray(props.deal?.deal_fillers) ? props.deal!.deal_fillers : [];
    const row = rows.find((df) => df?.filler?.id === p.target?.filler_id);
    return String(row?.value ?? '').trim();
}

/** the form already has a value the server does not know yet: it wins */
function inForm(p: AiParam): boolean {
    return p.state === 'ready' && !!formValue(p);
}

const readyKeys = computed(() => (data.value?.order_params ?? []).filter((p) => p.can_accept && !inForm(p)).map((p) => p.key));

function paramNote(p: AiParam): string {
    switch (p.state) {
        case 'ready':
            return inForm(p) ? `В форме уже введено: ${formValue(p)} — сохраните форму` : `Пустое поле сделки «${p.target?.field}»`;
        case 'accepted':
            return `Уже в поле «${p.target?.field}»`;
        case 'filled':
            return `В сделке другое значение: ${p.target?.current} (не меняется)`;
        default:
            return 'В сделке нет такого поля';
    }
}

function whoLabel(who: string | null | undefined): string {
    return who === 'client' ? 'Клиент' : 'Менеджер';
}

const LANGUAGES: Record<string, string> = {
    uz: 'узбекский', en: 'английский', tr: 'турецкий', kk: 'казахский', ky: 'киргизский', tg: 'таджикский',
    tk: 'туркменский', az: 'азербайджанский', zh: 'китайский', de: 'немецкий', ar: 'арабский', fa: 'персидский',
};

function languageLabel(code: string): string {
    return LANGUAGES[code.split('-')[0]] ?? code;
}

function channelLabel(channel: string): string {
    return ({ telegram: 'Telegram', whatsapp: 'WhatsApp', email: 'почта' } as Record<string, string>)[channel] ?? channel;
}

function stamp(value: string | null | undefined): string {
    if (!value) return '';
    const m = moment(value);
    if (!m.isValid()) return '';
    return m.isSame(moment(), 'day') ? `сегодня ${m.format('HH:mm')}` : m.format('DD.MM.YYYY HH:mm');
}

function day(value: string | null | undefined): string {
    const m = value ? moment(value) : null;
    return m?.isValid() ? m.format('DD.MM.YYYY') : '';
}

/** a due of the summary: "YYYY-MM-DDTHH:MM" or "YYYY-MM-DD" (Tashkent time, as the AI wrote it) */
function dueStamp(value: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value);
    if (!m) return value;
    return `${m[3]}.${m[2]}.${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`;
}

function overdue(p: AiItem): boolean {
    return !!p.due_at && moment(p.due_at).isBefore(moment());
}

async function onSummary() {
    const result = await props.ai.refreshSummary();
    if (!result.ok && result.message) toast.show({ message: result.message, type: 'error', timeout: 5000 });
}

async function onDismiss(itemId: number) {
    const result = await props.ai.dismiss(itemId);
    if (!result.ok && result.message) toast.show({ message: result.message, type: 'error', timeout: 4000 });
}

async function onAccept(keys: string[]) {
    const result = await props.ai.accept(keys);
    if (!result.ok) {
        if (result.message) toast.show({ message: result.message, type: 'error', timeout: 5000 });
        return;
    }
    patchForm(result.accepted);
    if (result.accepted.length) {
        toast.show({ message: `Записано в сделку: ${result.accepted.map((a) => a.field).join(', ')}`, type: 'success', timeout: 3000 });
    } else if (result.kept.length) {
        toast.show({ message: `Поля уже заполнены и не изменены: ${result.kept.map((k) => k.field).join(', ')}`, type: 'info', timeout: 4000 });
    }
}

/** the values written by «Принять» into the open form of the deal (with the ids of their rows) */
function patchForm(accepted: AiAccepted[]) {
    const deal = props.deal;
    if (!deal || !Array.isArray(deal.deal_fillers)) return;
    for (const item of accepted) {
        if (!item.deal_filler_id) continue;
        const row = deal.deal_fillers.find((df: any) => df?.filler?.id === item.filler_id);
        if (row) {
            row.id = item.deal_filler_id;
            row.new = false;
            if (!String(row.value ?? '').trim()) row.value = item.value;
        } else {
            deal.deal_fillers.push({
                id: item.deal_filler_id,
                value: item.value,
                filler: { id: item.filler_id, field: item.field, is_required: false },
                created_at: new Date().toISOString(),
            });
        }
    }
}
</script>
