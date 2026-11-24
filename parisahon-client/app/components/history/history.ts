/**
 * The readable client history (EventsList.vue and the components of this folder): the filters of the
 * feed, stage colours readable in both themes, the words of the deal header.
 * The API side is parisahon-api/src/history (filters, GET /deals/:id/summary, /client-events, /lost).
 */

/** «Всё / Переписка / Звонки / Задачи / Изменения»: `kind` of the feed requests (src/history/history-filters.ts). */
export type HistoryKind = 'all' | 'messages' | 'calls' | 'tasks' | 'changes';

export const HISTORY_KINDS: { id: HistoryKind; label: string; icon: string }[] = [
    { id: 'all', label: 'Всё', icon: 'ph:list-bullets' },
    { id: 'messages', label: 'Переписка', icon: 'ph:chats-circle' },
    { id: 'calls', label: 'Звонки', icon: 'ph:phone' },
    { id: 'tasks', label: 'Задачи', icon: 'ph:check-square' },
    { id: 'changes', label: 'Изменения', icon: 'ph:pencil-simple' },
];

export type HistoryFilters = { kind: HistoryKind; q: string };

export const emptyHistoryFilters = (): HistoryFilters => ({ kind: 'all', q: '' });

/** The query parameters of the filters (nothing for «Всё» and an empty search: the request stays as it was). */
export function historyQuery(filters: HistoryFilters | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (filters?.kind && filters.kind !== 'all') out.kind = filters.kind;
    const q = String(filters?.q ?? '').trim();
    if (q.length >= 2) out.q = q.slice(0, 100);
    return out;
}

export function filtersActive(filters: HistoryFilters | null | undefined): boolean {
    return Object.keys(historyQuery(filters)).length > 0;
}

// ------------------------------------------------------------------ stage colours

function rgbOf(color: string | null | undefined): [number, number, number] | null {
    const hex = String(color ?? '').trim().replace(/^#/, '');
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (!/^[0-9a-f]{6}$/i.test(full)) return null;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
    const [lr, lg, lb] = [r, g, b].map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(a: number, b: number): number {
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
}

/** The colour mixed with white (share 0..1). */
function tint(rgb: [number, number, number], share: number): [number, number, number] {
    return rgb.map((v) => Math.round(v + (255 - v) * share)) as [number, number, number];
}

const hexOf = (rgb: [number, number, number]) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

const DARK_TEXT = '#1f2937';
const LIGHT_TEXT = '#ffffff';
const DARK_TEXT_L = luminance([0x1f, 0x29, 0x37]);

/** Text of the better contrast on a background (dark text unless white reads clearly better). */
function textOn(rgb: [number, number, number]): string {
    const l = luminance(rgb);
    return contrast(l, DARK_TEXT_L) >= contrast(l, 1) ? DARK_TEXT : LIGHT_TEXT;
}

/**
 * The colours of a stage chip in both themes (owner's report: «ЗАКРЫТО И НЕ РЕАЛИЗОВАНО» dark brown on
 * the dark card could not be read). Light theme: the stage colour with the text of the better contrast.
 * Dark theme: a dark colour (it would melt into the card) is lightened until it stands out from the
 * card (slate-800) and carries dark text. Without a colour: the neutral chip of the theme.
 */
export function stageTones(color: string | null | undefined): Record<string, string> {
    const rgb = rgbOf(color);
    if (!rgb) return {};
    let dark = rgb;
    const card = luminance([0x1e, 0x29, 0x3b]); // muted-800, the card of the dark theme
    for (let share = 0.15; contrast(luminance(dark), card) < 3 && share <= 0.9; share += 0.15) {
        dark = tint(rgb, share);
    }
    return {
        '--stage-bg': hexOf(rgb),
        '--stage-fg': textOn(rgb),
        '--stage-bg-dark': hexOf(dark),
        '--stage-fg-dark': textOn(dark),
    };
}

// ------------------------------------------------------------------ the deal header

export const SOURCE_LABELS: Record<string, { label: string; icon: string }> = {
    telegram: { label: 'Telegram', icon: 'ph:telegram-logo' },
    whatsapp: { label: 'WhatsApp', icon: 'ph:whatsapp-logo' },
    email: { label: 'e-mail', icon: 'ph:envelope-simple' },
    call: { label: 'звонок', icon: 'ph:phone' },
    manual: { label: 'вручную', icon: 'ph:hand-pointing' },
};

function ruPlural(n: number, one: string, few: string, many: string): string {
    const tens = Math.abs(n) % 100;
    const units = tens % 10;
    if (tens >= 11 && tens <= 14) return many;
    if (units === 1) return one;
    if (units >= 2 && units <= 4) return few;
    return many;
}

/** «0 дней», «1 день», «12 дней» */
export function daysText(days: number): string {
    const n = Math.max(0, Math.floor(Number(days) || 0));
    return `${n} ${ruPlural(n, 'день', 'дня', 'дней')}`;
}

/** «5 мин», «2 ч 10 мин», «3 дня» — how long the client has been waiting. */
export function waitText(minutes: number): string {
    const m = Math.max(0, Math.floor(Number(minutes) || 0));
    if (m < 60) return `${m} мин`;
    const hours = Math.floor(m / 60);
    if (hours < 24) return m % 60 ? `${hours} ч ${m % 60} мин` : `${hours} ч`;
    const days = Math.floor(hours / 24);
    return `${days} ${ruPlural(days, 'день', 'дня', 'дней')}`;
}

/** GET /deals/:id/summary */
export type DealSummary = {
    id: number;
    display_id: number;
    label: string;
    created_at: string;
    closed_at: string | null;
    stage: { id: number; name: string; color: string | null; kind: string | null } | null;
    stage_since: string;
    days_in_stage: number;
    source: 'telegram' | 'whatsapp' | 'email' | 'call' | 'manual';
    waiting: { since: string; minutes: number; channel: string | null } | null;
    lost_reason: string | null;
    lost_comment: string | null;
    lost_reasons: string[];
    repeat_of: { id: number; display_id: number; label: string } | null;
    client_deals: number;
};

/** The reasons offered when the summary is not loaded yet (the same list as src/history/lost-reasons.ts). */
export const DEFAULT_LOST_REASONS = [
    'Цена',
    'Сроки поставки',
    'Качество или образцы',
    'Ушёл к конкуренту',
    'Нет нужного товара',
    'Клиент не отвечает',
    'Неактуально для клиента',
    'Другое',
];
