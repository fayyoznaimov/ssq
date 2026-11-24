import { bus } from '~/constants';

/**
 * «Почему сделка не реализована?» (DEAL-11): asked when a deal goes to the stage of kind `lost` — saved
 * in the deal form (single.vue) or dropped into that column of the board (ProgressColumn.vue). The
 * modal (LostReasonModal.vue, mounted once on the page) saves it itself (PATCH /deals/:id/lost) and
 * answers with what was saved, or null when the manager closed it (the deal stays lost, without a
 * reason; the deal header offers «Указать причину» later).
 */
export const LOST_REASON_MODAL = 'LostReasonModal';

export type LostReasonAnswer = { lost_reason: string; lost_comment: string | null } | null;
export type LostReasonRequest = {
    deal: { id: number; display_id?: number | null; label?: string | null };
    reasons?: string[];
    reason?: string | null;
    comment?: string | null;
    resolve: (answer: LostReasonAnswer) => void;
};

let mounted = 0;

export function lostReasonModalMounted(): () => void {
    mounted++;
    return () => {
        mounted = Math.max(0, mounted - 1);
    };
}

/** Asks the reason of a lost deal and saves it; null when the page has no modal or it was closed. */
export function askLostReason(request: Omit<LostReasonRequest, 'resolve'>): Promise<LostReasonAnswer> {
    if (!mounted) return Promise.resolve(null);
    return new Promise((resolve) => bus.emit('modals.open', { id: LOST_REASON_MODAL, data: { ...request, resolve } }));
}

/** A stage of kind «lost» («Закрыто и не реализовано»). */
export function isLostStage(stage: { kind?: string | null } | null | undefined): boolean {
    return stage?.kind === 'lost';
}
