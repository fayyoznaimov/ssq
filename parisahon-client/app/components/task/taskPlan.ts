/**
 * The plan rules of the API for a task (task.service.ts, the same for the web and the bot):
 *  - 400 TASK_IN_PAST: the time has passed already (a typo in the year, a wrong day): saved only when
 *    the user confirms it is deliberate (the task is already done, a backdated one) → allow_past;
 *  - 409 TASK_DUPLICATE: the deal has another open task within ±15 minutes (the answer names it):
 *    saved only when the user confirms → allow_duplicate.
 *
 * `send(flags)` makes the request with the flags merged into its body. The user is asked with the
 * server's own words; a refusal ends with TaskPlanCancelled (the caller shows nothing or a short note).
 */
export const TASK_PLAN_FLAGS: Record<string, string> = {
    TASK_IN_PAST: 'allow_past',
    TASK_DUPLICATE: 'allow_duplicate',
};

export class TaskPlanCancelled extends Error {
    readonly cancelled = true;

    constructor() {
        super('Задача не сохранена');
    }
}

function planCode(error: any): string | undefined {
    const code = error?.data?.code ?? error?.data?.data?.code;
    return typeof code === 'string' && code in TASK_PLAN_FLAGS ? code : undefined;
}

function question(code: string): string {
    return code === 'TASK_IN_PAST' ? 'Сохранить задачу на это время?' : 'Всё равно создать ещё одну задачу?';
}

export async function confirmTaskPlan<T>(send: (flags: Record<string, boolean>) => Promise<T>): Promise<T> {
    const flags: Record<string, boolean> = {};
    // at most both rules, each asked once
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await send({...flags});
        } catch (error: any) {
            const code = planCode(error);
            if (!code || flags[TASK_PLAN_FLAGS[code]]) throw error;
            const message = error?.data?.message ?? error?.message ?? '';
            if (!window.confirm(`${message}\n\n${question(code)}`)) throw new TaskPlanCancelled();
            flags[TASK_PLAN_FLAGS[code]] = true;
        }
    }
    return send({...flags});
}

/** A refusal of the confirmation is not an error to show. */
export function isTaskPlanCancelled(error: unknown): boolean {
    return !!(error as any)?.cancelled;
}
