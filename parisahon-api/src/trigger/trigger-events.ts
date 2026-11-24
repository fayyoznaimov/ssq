/**
 * Events of the trigger module for the rest of the API (EventEmitter2, no module import needed).
 *
 * TRIGGER_RUN_FAILED: an execution of a trigger failed (the error is in its trigger_run row);
 * BotWaitingService tells the admins who linked the CRM bot.
 */
export const TRIGGER_RUN_FAILED = 'trigger.run.failed';

export interface TriggerRunFailure {
  trigger_id: number;
  trigger_type: number;
  // the action as the settings page names it («Отправить письмо»)
  action?: string;
  stage_id: number | null;
  stage_name: string | null;
  deal_id: number;
  deal_display_id: number | null;
  deal_label: string | null;
  // in words (TriggerService.humanError); the run keeps the original text
  error: string;
}

/**
 * TRIGGER_BROKEN: triggers that name something gone (a dismissed employee, a deleted template, stage,
 * task type or field) — TriggerService finds them every 10 minutes and sends the ones not told within
 * a day as one summary; BotWaitingService tells the admins who linked the CRM bot in one message. The
 * settings page shows them too.
 */
export const TRIGGER_BROKEN = 'trigger.broken';

export interface TriggerBrokenReport {
  trigger_id: number;
  action: string;
  stage_id: number | null;
  stage_name: string | null;
  problems: string[];
}

export interface TriggerBrokenSummary {
  triggers: TriggerBrokenReport[];
}

/**
 * TRIGGER_NOTIFY: the action «Уведомить» of a trigger. Sent with emitAsync: the listener
 * (BotWaitingService) answers the ids of the employees the CRM bot told; the others get a task.
 */
export const TRIGGER_NOTIFY = 'trigger.notify';

export interface TriggerNotification {
  user_ids: number[];
  text: string;
  deal_id: number;
}
