import type { LiveChanges } from '~/composables/useLive';
import { promiseResult } from '~/utils/result';

/**
 * The «ИИ» of a deal (parisahon-api/src/ai, GET /deals/:id/ai): the summary, the client's questions left
 * without an answer, the promises, the order parameters found in the conversation, the flags.
 * One instance per deal page (components/deal/single.vue): it decides whether the tab «ИИ» is shown at
 * all (the AI is off unless AI_FEATURES=1 on the server) and feeds the panel (components/ai/DealAiPanel.vue).
 * Live: the API sends 'changed' {ai: [dealId]} when an analysis or a summary of the deal is ready or an
 * item is closed, 'deals' when its fields change (the «Принять» buttons depend on them).
 */
export type AiMessageRef = { at: string; from: 'client' | 'manager' | 'note'; channel: string; excerpt: string };
export type AiPromise = { who: 'manager' | 'client' | string | null; what?: string; text?: string; due: string | null; event_id: number | null };
export type AiSummaryData = {
    client_wants: string;
    client_wants_refs: number[];
    promised: AiPromise[];
    open_questions: { text: string; event_id: number | null }[];
    next_step: string;
    next_step_refs: number[];
};
export type AiSummaryState = {
    status: 'none' | 'stale' | 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'empty';
    fresh: boolean;
    cached?: boolean;
    job_id: number | null;
    made_at: string | null;
    data: AiSummaryData | null;
    error: string | null;
};
export type AiItem = {
    id: number;
    text: string;
    who?: string | null;
    /** promises: "2026-11-25 18:00" (Tashkent), the moment, whether a time of day was named */
    due?: string | null;
    due_at?: string | null;
    due_has_time?: boolean;
    event_id: number | null;
    found_at: string;
    task_id: number | null;
    task_closed: boolean;
};
export type AiParam = {
    key: string;
    label: string;
    value: string;
    event_id: number;
    at: string;
    target: { filler_id: number; field: string; deal_filler_id: number | null; current: string | null } | null;
    state: 'ready' | 'accepted' | 'filled' | 'no_field';
    can_accept: boolean;
};
export type DealAiView = {
    enabled: boolean;
    features: { enabled: boolean; turns: boolean; summary: boolean; question_tasks: boolean; promise_tasks: boolean };
    can_update: boolean;
    paused_until?: string | null;
    pause_reason?: string | null;
    deal_closed?: boolean;
    analysing?: boolean;
    budget_spent?: boolean;
    summary: AiSummaryState | null;
    questions: AiItem[];
    promises: AiItem[];
    order_params: AiParam[];
    missing_fields: string[];
    flags: { flag: string; label: string; count: number; last_at: string; event_id: number }[];
    turns: { id: number; event_id: number; at: string; summary: string | null; language: string | null; channels: string[] }[];
    refs: Record<string, AiMessageRef>;
};
export type AiAccepted = { key: string; field: string; filler_id: number; value: string; deal_filler_id: number | null };

export function useDealAi(dealId: () => string | number | undefined | null) {
    const dealService = useService('deals', { auth: true });
    const data = ref<DealAiView | null>(null);
    const loading = ref(false);
    const summarizing = ref(false);
    const accepting = ref<string | null>(null);
    const dismissing = ref<number | null>(null);
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let pollUntil = 0;
    let loadedFor: string | null = null;

    const id = () => {
        const value = dealId();
        return value === undefined || value === null || value === '' ? null : String(value);
    };

    async function load() {
        const current = id();
        if (!current) {
            data.value = null;
            return;
        }
        loading.value = true;
        const result = await promiseResult(dealService.get(`${current}/ai`).exec());
        loading.value = false;
        if (id() !== current) return; // another deal was opened meanwhile
        loadedFor = current;
        if (result.ok) data.value = result.value as DealAiView;
        else if (!data.value) data.value = null;
        schedulePoll();
    }

    function stopPoll() {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
    }

    /** a summary being made: the live update brings it, this is the fallback without a socket */
    function schedulePoll() {
        stopPoll();
        const status = data.value?.summary?.status;
        if ((status === 'queued' || status === 'running') && Date.now() < pollUntil) pollTimer = setTimeout(load, 10_000);
    }

    /** «Обновить»: the summary for the current conversation (made now, or from the cache) */
    async function refreshSummary(): Promise<{ ok: boolean; message?: string }> {
        const current = id();
        if (!current || summarizing.value) return { ok: false };
        summarizing.value = true;
        pollUntil = Date.now() + 5 * 60_000;
        const result = await promiseResult(dealService.post(`${current}/ai/summary`, {}).exec());
        summarizing.value = false;
        if (id() !== current) return { ok: false };
        if (!result.ok) return { ok: false, message: result.error.message };
        if (data.value) data.value.summary = result.value as AiSummaryState;
        await load();
        return { ok: true };
    }

    /** «Принять»: order parameters into the empty deal fields (all of them without keys) */
    async function accept(keys?: string[]): Promise<{ ok: boolean; message?: string; accepted: AiAccepted[]; kept: { field: string }[] }> {
        const current = id();
        if (!current) return { ok: false, accepted: [], kept: [] };
        accepting.value = keys?.length === 1 ? keys[0] : '*';
        const result = await promiseResult(dealService.post(`${current}/ai/accept`, keys?.length ? { keys } : {}).exec());
        accepting.value = null;
        if (!result.ok) return { ok: false, message: result.error.message, accepted: [], kept: [] };
        const value = result.value as { accepted: AiAccepted[]; kept: { field: string }[] };
        await load();
        return { ok: true, accepted: value.accepted ?? [], kept: value.kept ?? [] };
    }

    /** «Снять»: the question needs no answer / the promise is not needed */
    async function dismiss(itemId: number): Promise<{ ok: boolean; message?: string }> {
        const current = id();
        if (!current) return { ok: false };
        dismissing.value = itemId;
        const result = await promiseResult(dealService.post(`${current}/ai/items/${itemId}/dismiss`, {}).exec());
        dismissing.value = null;
        if (!result.ok) return { ok: false, message: result.error.message };
        if (data.value) {
            data.value.questions = data.value.questions.filter((q) => q.id !== itemId);
            data.value.promises = data.value.promises.filter((p) => p.id !== itemId);
        }
        load();
        return { ok: true };
    }

    /** the tab is shown only while the AI of the CRM is on */
    const enabled = computed(() => !!data.value?.enabled);
    /** what waits for the manager: questions without an answer and the manager's own promises */
    const openCount = computed(() => {
        if (!data.value?.enabled) return 0;
        return data.value.questions.length + data.value.promises.filter((p) => p.who === 'manager').length;
    });
    const tabLabel = computed(() => (openCount.value ? `ИИ · ${openCount.value}` : 'ИИ'));

    // what the AI found ('ai'); a new message or note makes the summary stale ('events' of this deal);
    // the deal's fields decide the «Принять» buttons ('deals', only when there are parameters to accept).
    // A change of "any" deal or event ('*', bulk updates elsewhere) does not reload the block, except all
    // topics at once (the socket came back after a break: useLive sends every topic as '*').
    const named = (changes: LiveChanges, topic: string, current: string) =>
        Array.isArray(changes[topic]) && (changes[topic] as number[]).includes(Number(current));
    useLive((changes) => {
        const current = id();
        if (!current) return;
        if (
            liveTouches(changes, 'ai', current) ||
            (changes.deals === '*' && changes.events === '*') ||
            named(changes, 'events', current) ||
            (named(changes, 'deals', current) && !!data.value?.order_params?.length)
        ) {
            load();
        }
    }, 1000);

    watch(
        () => id(),
        (current) => {
            if (current === loadedFor) return;
            data.value = null;
            stopPoll();
            if (import.meta.client) load();
        },
        { immediate: true },
    );

    onUnmounted(stopPoll);

    return { data, loading, summarizing, accepting, dismissing, enabled, openCount, tabLabel, load, refreshSummary, accept, dismiss };
}

export type DealAi = ReturnType<typeof useDealAi>;
