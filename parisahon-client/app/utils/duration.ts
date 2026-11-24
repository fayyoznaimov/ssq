/**
 * Durations as people say them in the reports (the API sends seconds or milliseconds; the client formats):
 *   clock(125)        «2:05», clock(3725) «1:02:05»   — the length of a call
 *   spoken(40)        «40 с», spoken(720) «12 мин», spoken(3900) «1 ч 05 мин» — totals and response times
 * No value — a dash.
 */
export function clock(seconds: number | string | null | undefined): string {
    if (seconds === null || seconds === undefined || seconds === '') return '—';
    const s = Math.round(Number(seconds));
    if (!Number.isFinite(s) || s < 0) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function spoken(seconds: number | string | null | undefined): string {
    if (seconds === null || seconds === undefined || seconds === '') return '—';
    const s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) return '—';
    if (s < 60) return `${Math.round(s)} с`;
    if (s < 3600) return `${Math.round(s / 60)} мин`;
    const minutes = Math.round(s / 60);
    return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}
