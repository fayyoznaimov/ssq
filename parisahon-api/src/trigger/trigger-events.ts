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
