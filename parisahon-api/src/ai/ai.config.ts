/**
 * Switches and numbers of the AI features (src/ai), read from the environment on every use.
 *
 * Everything is off until AI_FEATURES=1. With it on, the features that only show something are on
 * (turn analysis on the deal page, the deal summary) and the ones that create tasks stay "notify
 * only" until switched on (AI_QUESTION_TASKS, AI_PROMISE_TASKS). See parisahon-api/.env.example.
 *
 * The AI runs through the server's Claude CLI (recognition/claude-cli.client.ts) with the company's
 * claude.ai subscription, whose usage limit is shared with the people using claude.ai: background
 * work (the turn analysis) has a daily budget of CLI calls (AI_DAILY_BUDGET) and stops for an hour
 * when the CLI reports the limit (AI_LIMIT_PAUSE_MIN); people's requests (a summary button, the bot)
 * are not budgeted, only limited per user and hour.
 */
function flag(name: string, fallback: boolean): boolean {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return !['0', 'false', 'off', 'no'].includes(value);
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? '').trim();
  const value = raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const AI = {
  /** the main switch: nothing of src/ai works without it (no worker, the endpoints say «выключено») */
  get enabled(): boolean {
    return flag('AI_FEATURES', false);
  },
  /** «Разбор хода»: background analysis of the client's messages and the manager's answer */
  get turns(): boolean {
    return this.enabled && flag('AI_TURNS', true);
  },
  /** «Сводка сделки»: the button on the deal page and the bot tool */
  get summary(): boolean {
    return this.enabled && flag('AI_SUMMARY', true);
  },
  /** «Вопрос без ответа» → a task after the SLA (off = shown on the deal only) */
  get questionTasks(): boolean {
    return this.turns && flag('AI_QUESTION_TASKS', false);
  },
  /** «Обещания → задачи» (off = shown on the deal only) */
  get promiseTasks(): boolean {
    return this.turns && flag('AI_PROMISE_TASKS', false);
  },
  /** CLI calls of background jobs per day (local date); 0 = background AI does not run */
  get dailyBudget(): number {
    return num('AI_DAILY_BUDGET', 150, 0, 100000);
  },
  /** how often the worker looks for new turns and runs the queue */
  get workerSec(): number {
    return num('AI_WORKER_SEC', 30, 1, 3600);
  },
  /** a turn is analysed this long after the manager's last answer, or at once when the client writes again */
  get quietMin(): number {
    return num('AI_TURN_QUIET_MIN', 10, 0, 1440);
  },
  /** working minutes an unanswered question waits on the deal page before it becomes a task (0 = at once) */
  get questionSlaMin(): number {
    return num('AI_QUESTION_SLA_MIN', 30, 0, 10080);
  },
  /** tasks made from the manager's promises, per deal and day */
  get promiseTasksPerDay(): number {
    return num('AI_PROMISE_TASKS_PER_DAY', 2, 0, 20);
  },
  /** pause of all AI after the CLI reported the usage limit of the subscription */
  get limitPauseMin(): number {
    return num('AI_LIMIT_PAUSE_MIN', 60, 1, 1440);
  },
  /** pause after the CLI did not work at all (signed out, missing, no answer) */
  get unavailablePauseMin(): number {
    return num('AI_UNAVAILABLE_PAUSE_MIN', 15, 1, 1440);
  },
  /** tries of one job (a broken answer, a timeout) before it is "failed" */
  get maxAttempts(): number {
    return num('AI_MAX_ATTEMPTS', 3, 1, 10);
  },
  /** summary requests per user and hour that need a new CLI call (cached answers are free) */
  get perUserHour(): number {
    return num('AI_INTERACTIVE_PER_HOUR', 30, 1, 10000);
  },
  /** only chat messages of the last N days are analysed */
  get activeDays(): number {
    return num('AI_ACTIVE_DAYS', 30, 1, 365);
  },
  /** finished jobs are deleted after N days */
  get keepDays(): number {
    return num('AI_JOBS_KEEP_DAYS', 180, 7, 3650);
  },
  /** how long the summary button waits for the answer before it says «готовится» (the page then polls) */
  get summaryWaitSec(): number {
    return num('AI_SUMMARY_WAIT_SEC', 50, 1, 120);
  },
  /** how long the bot tool waits for a summary */
  get botWaitSec(): number {
    return num('AI_BOT_WAIT_SEC', 40, 1, 120);
  },
  get model(): string {
    return (process.env.AI_MODEL || process.env.CLAUDE_RECOGNITION_MODEL || 'claude-opus-5-5').trim();
  },
  get effort(): string {
    return (process.env.AI_EFFORT || 'low').trim();
  },
  get timeoutSec(): number {
    return num('AI_TIMEOUT_SEC', 120, 30, 600);
  },
  /**
   * Test stands only: the background AI looks only at deals whose name starts with this (the
   * AUDIT-ai-… deals of local/checks/ai_check.py), so the deals of the other check sets are left
   * alone. Empty (production): every open deal.
   */
  get testDealPrefix(): string {
    return (process.env.AI_TEST_DEAL_PREFIX || '').trim();
  },
  /** what GET /ai/status and the deal page show about the switches */
  features(): Record<string, boolean> {
    return {
      enabled: this.enabled,
      turns: this.turns,
      summary: this.summary,
      question_tasks: this.questionTasks,
      promise_tasks: this.promiseTasks,
    };
  },
};

/** Prompt versions: a new version is a new input (the cache and the dedupe key include it). */
export const PROMPT_VERSION = {
  turn: 'turn-1',
  summary: 'summary-1',
};

/** Queue priority, the smaller the sooner: a person waiting > an event > a nightly batch. */
export enum AiPriority {
  INTERACTIVE = 0,
  EVENT = 1,
  NIGHTLY = 2,
}

/** Labels of the tasks the AI makes (the rules find their own tasks by these prefixes). */
export const AI_TASK_PREFIX = 'Авто (ИИ): ';
export const AI_QUESTION_TASK = 'Авто (ИИ): ответьте клиенту на вопрос';
