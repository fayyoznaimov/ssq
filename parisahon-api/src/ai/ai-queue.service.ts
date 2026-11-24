import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ClaudeCliClient, ClaudeCliError, claudeCliLoad } from '../recognition/claude-cli.client';
import { NotificationGateWay } from '../gateway/notification.gateway';
import { AI, AiPriority } from './ai.config';
import { AiJobStatus } from './ai-job.entity';
import { parseJsonObject } from './ai-prompts';
import { AuditJournal } from '../audit/audit-journal';

/**
 * The AI queue (table ai_job) and its worker.
 *
 *  - Feature services register a handler per kind ("turn", "summary") and tickers (the turn detector,
 *    the question SLA); every AI_WORKER_SEC the worker runs the tickers, then takes queued jobs:
 *    the smallest priority first (0 a person waits, 1 an event, 2 a nightly batch), oldest first.
 *  - The Claude CLI runs at most CLAUDE_MAX_PARALLEL (2) processes for the whole CRM (card recognition,
 *    the mail assistant and the bot use it too): a background job starts only while it leaves one slot
 *    free, so a person never waits behind the AI's own work; a person's job takes any free slot.
 *  - Background jobs have a daily budget of CLI calls (AI_DAILY_BUDGET, table ai_usage); a person's are
 *    counted, not limited here (the summary limits per user and hour).
 *  - The same input never goes to the CLI twice: the job is unique per kind and input hash.
 *  - The CLI reports the usage limit of the subscription: all AI pauses for AI_LIMIT_PAUSE_MIN (60);
 *    the CLI does not work at all (signed out, missing): AI_UNAVAILABLE_PAUSE_MIN (15). The job goes
 *    back to the queue without losing a try. A broken answer is tried again later, AI_MAX_ATTEMPTS in all.
 *  - A job left "running" by a stopped API is queued again at the start.
 */
export interface AiJobRow {
  id: number;
  kind: string;
  entity: string;
  entity_id: number;
  input_hash: string;
  input: Record<string, any> | null;
  priority: number;
  status: AiJobStatus;
  attempts: number;
  run_after: Date;
  result: Record<string, any> | null;
  error: string | null;
  prompt_version: string;
  model: string | null;
  requested_by: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
}

export interface AiOutcome {
  /** stored in ai_job.result */
  result?: Record<string, any> | null;
  /** nothing to do after all (the deal was closed meanwhile, ...): the job is "skipped" with this reason */
  skipped?: string;
}

type Handler = (job: AiJobRow) => Promise<AiOutcome>;

/** The model did not answer in the asked format. */
export class AiFormatError extends Error {}

/** All AI waits (the usage limit of the subscription, the CLI does not work). */
export class AiPausedError extends Error {
  constructor(
    readonly until: Date,
    readonly reason: string,
  ) {
    super(`ИИ на паузе до ${until.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}: ${reason}`);
  }
}

/** What the CLI says when the subscription's usage limit is reached ("5-hour limit reached ∙ resets 3pm", "usage limit", 429). */
export function isUsageLimit(message: string): boolean {
  return /(usage|session|weekly|daily|5-hour|hourly) limit|limit (reached|exceeded|will reset)|hit your (usage )?limit|out of (extra )?usage|rate.?limit|\b429\b/i.test(
    message,
  );
}

/** TypeORM answers [rows, count] to UPDATE / DELETE ... RETURNING on Postgres, plain rows otherwise. */
export function returnedRows(result: any): any[] {
  return Array.isArray(result?.[0]) ? result[0] : Array.isArray(result) ? result : [];
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

@Injectable()
export class AiQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AiQueue');
  private readonly handlers = new Map<string, Handler>();
  private readonly tickers: Array<{ name: string; run: () => Promise<unknown> }> = [];
  private readonly waiters = new Map<number, Set<() => void>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private pumping = false;
  private pumpAgain = false;
  private stopped = false;
  /** jobs of this process taken from the queue and not finished, by kind of slot */
  private readonly active = { interactive: 0, background: 0 };
  /** of them, inside ClaudeCliClient.run (counted by claudeCliLoad() too) */
  private inCli = 0;
  /** the model the CLI reported for a running job (stored with its result) */
  private readonly lastModel = new Map<number, string | null>();
  private cleanedOn = '';

  constructor(
    private dataSource: DataSource,
    private claude: ClaudeCliClient,
    private gateway: NotificationGateWay,
  ) {}

  register(kind: string, handler: Handler): void {
    this.handlers.set(kind, handler);
  }

  addTicker(name: string, run: () => Promise<unknown>): void {
    this.tickers.push({ name, run });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!AI.enabled) {
      this.logger.log('AI features are off (AI_FEATURES=0)');
      return;
    }
    try {
      await this.dataSource.query(`UPDATE ai_job SET status = 'queued', run_after = now() WHERE status = 'running'`);
    } catch (error) {
      this.logger.error(`AI tables are missing? ${(error as Error).message}`);
      return;
    }
    // the journal (src/audit): what the AI worker writes by itself is the AI's (source «ИИ»)
    this.timer = setInterval(() => void AuditJournal.job('ai', 'ai-queue', () => this.tick()), AI.workerSec * 1000);
    setTimeout(() => void AuditJournal.job('ai', 'ai-queue', () => this.tick()), 2000);
    this.logger.log(`AI worker every ${AI.workerSec} s, background budget ${AI.dailyBudget} CLI calls a day`);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** The detectors, the cleanup once a day, then the queue. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped || !AI.enabled) return;
    this.ticking = true;
    try {
      for (const ticker of this.tickers) {
        try {
          await ticker.run();
        } catch (error) {
          this.logger.warn(`${ticker.name}: ${(error as Error).message}`);
        }
      }
      await this.cleanup();
      await this.pump();
    } catch (error) {
      this.logger.warn(`tick: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  // ------------------------------------------------------------------ jobs

  /**
   * Adds a job, or finds the one with the same kind and input (created: false): the same input is
   * never asked twice. A person's job starts at once when a CLI slot is free.
   */
  async enqueue(job: {
    kind: string;
    entity: string;
    entityId: number;
    inputHash: string;
    input: Record<string, any>;
    priority: AiPriority;
    promptVersion: string;
    requestedBy?: number | null;
  }): Promise<{ job: AiJobRow; created: boolean }> {
    const inserted = returnedRows(
      await this.dataSource.query(
        `INSERT INTO ai_job (kind, entity, entity_id, input_hash, input, priority, prompt_version, requested_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (kind, input_hash) DO NOTHING RETURNING *`,
        [job.kind, job.entity, job.entityId, job.inputHash, JSON.stringify(job.input), job.priority, job.promptVersion, job.requestedBy ?? null],
      ),
    );
    if (inserted[0]) {
      if (job.priority === AiPriority.INTERACTIVE) this.kick();
      return { job: inserted[0], created: true };
    }
    const existing = await this.find(job.kind, job.inputHash);
    if (existing && existing.status === 'queued' && job.priority < existing.priority) {
      // a person asks for what waits as background work: it becomes theirs
      await this.dataSource.query(`UPDATE ai_job SET priority = $2 WHERE id = $1 AND status = 'queued'`, [existing.id, job.priority]);
      existing.priority = job.priority;
      this.kick();
    }
    return { job: existing, created: false };
  }

  async find(kind: string, inputHash: string): Promise<AiJobRow | null> {
    const rows = await this.dataSource.query(`SELECT * FROM ai_job WHERE kind = $1 AND input_hash = $2`, [kind, inputHash]);
    return rows[0] ?? null;
  }

  async get(id: number): Promise<AiJobRow | null> {
    const rows = await this.dataSource.query(`SELECT * FROM ai_job WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** A failed (or skipped) job asked for again by a person: one more round of tries. */
  async retry(id: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE ai_job SET status = 'queued', attempts = 0, run_after = now(), error = NULL, finished_at = NULL
        WHERE id = $1 AND status IN ('failed', 'skipped')`,
      [id],
    );
    this.kick();
  }

  /**
   * Waits until the job is done, failed or skipped, at most `ms`; the job as it is then. Also returns
   * early when the AI is paused meanwhile (the caller tells the person).
   */
  async wait(id: number, ms: number): Promise<AiJobRow | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const job = await this.get(id);
      if (!job || ['done', 'failed', 'skipped'].includes(job.status)) return job;
      const left = deadline - Date.now();
      if (left <= 0 || (await this.pause())) return job;
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(id) ?? new Set<() => void>();
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          if (!set.size) this.waiters.delete(id);
          resolve();
        };
        // the job may run in another process: look again every few seconds anyway
        const timer = setTimeout(done, Math.min(left, 3000));
        set.add(done);
        this.waiters.set(id, set);
      });
    }
  }

  private notify(id: number): void {
    for (const done of [...(this.waiters.get(id) ?? [])]) done();
  }

  /** Runs the queue soon, without waiting for the timer. */
  kick(): void {
    if (this.stopped || !AI.enabled) return;
    setImmediate(() => void this.pump().catch((error) => this.logger.warn(`pump: ${(error as Error).message}`)));
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      for (let guard = 0; guard < 20 && !this.stopped; guard++) {
        if (await this.pause()) return;
        const cli = claudeCliLoad();
        // CLI processes of everybody else (bot, recognition, mail assistant) + this process's jobs
        const busy = cli.running + cli.waiting - this.inCli + this.active.interactive + this.active.background;
        const free = cli.max - busy;
        if (free <= 0) return;
        let job = await this.claim([AiPriority.INTERACTIVE]);
        if (job) {
          this.start(job, 'interactive');
          continue;
        }
        // background: one slot always stays free for people
        const reserve = cli.max > 1 ? 1 : 0;
        if (free - reserve <= 0 || this.active.background >= Math.max(1, cli.max - 1)) return;
        if ((await this.backgroundCallsToday()) >= AI.dailyBudget) return;
        job = await this.claim([AiPriority.EVENT, AiPriority.NIGHTLY]);
        if (!job) return;
        this.start(job, 'background');
      }
    } finally {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        this.kick();
      }
    }
  }

  private async claim(priorities: number[]): Promise<AiJobRow | null> {
    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE ai_job SET status = 'running', started_at = now(), attempts = attempts + 1
          WHERE id = (SELECT id FROM ai_job WHERE status = 'queued' AND run_after <= now() AND priority = ANY($1)
                       ORDER BY priority, run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        [priorities],
      ),
    );
    return rows[0] ?? null;
  }

  private start(job: AiJobRow, slot: 'interactive' | 'background'): void {
    this.active[slot]++;
    // every job is an operation of the AI in the journal, also when a person's request woke the queue up
    // (its tasks are not the person's)
    void AuditJournal.job('ai', `ai-job:${job.id}`, () => this.execute(job)).finally(() => {
      this.active[slot]--;
      this.notify(job.id);
      if (job.entity === 'deal') this.changed(job.entity_id);
      this.kick();
    });
  }

  /** The deal page reloads its AI block (socket 'changed' {ai: [dealId]}: ids only, never data). */
  private changed(dealId: number): void {
    try {
      this.gateway.server?.emit('changed', { ai: [dealId] });
    } catch (error) {
      this.logger.warn(`live update: ${(error as Error).message}`);
    }
  }

  private async execute(job: AiJobRow): Promise<void> {
    const started = Date.now();
    try {
      const handler = this.handlers.get(job.kind);
      if (!handler) throw new Error(`нет обработчика для «${job.kind}»`);
      const outcome = await handler(job);
      await this.dataSource.query(
        `UPDATE ai_job SET status = $2, result = $3::jsonb, error = $4, finished_at = now(), duration_ms = $5,
                model = COALESCE($6, model)
          WHERE id = $1`,
        [
          job.id,
          outcome.skipped ? 'skipped' : 'done',
          outcome.result === undefined || outcome.result === null ? null : JSON.stringify(outcome.result),
          outcome.skipped ?? null,
          Date.now() - started,
          this.lastModel.get(job.id) ?? null,
        ],
      );
    } catch (error) {
      await this.failed(job, error as Error, Date.now() - started).catch((e) =>
        this.logger.error(`job ${job.id}: cannot record the failure: ${(e as Error).message}`),
      );
    } finally {
      this.lastModel.delete(job.id);
    }
  }

  private async failed(job: AiJobRow, error: Error, ms: number): Promise<void> {
    const message = String(error?.message ?? error).slice(0, 1000);
    const cliError = error instanceof ClaudeCliError;
    if (cliError && isUsageLimit(message)) {
      const until = await this.setPause(AI.limitPauseMin, 'исчерпан лимит подписки Claude', true);
      this.logger.warn(`job ${job.id}: usage limit of the subscription, all AI paused until ${until.toISOString()}`);
      await this.requeue(job, until, message, true);
      return;
    }
    if (cliError && (error as ClaudeCliError).unavailable) {
      const until = await this.setPause(AI.unavailablePauseMin, `Claude CLI не работает: ${message}`.slice(0, 250));
      this.logger.warn(`job ${job.id}: the CLI does not work (${message}), AI paused until ${until.toISOString()}`);
      await this.requeue(job, until, message, true);
      return;
    }
    if (job.attempts < AI.maxAttempts) {
      const later = new Date(Date.now() + Math.min(30, 2 ** job.attempts) * 60_000);
      this.logger.warn(`job ${job.id} (${job.kind}): ${message}; try ${job.attempts + 1} after ${later.toISOString()}`);
      await this.requeue(job, later, message, false);
      return;
    }
    this.logger.warn(`job ${job.id} (${job.kind}) failed after ${job.attempts} tries: ${message}`);
    await this.dataSource.query(
      `UPDATE ai_job SET status = 'failed', error = $2, finished_at = now(), duration_ms = $3 WHERE id = $1`,
      [job.id, message, ms],
    );
  }

  private async requeue(job: AiJobRow, runAfter: Date, error: string, keepTry: boolean): Promise<void> {
    await this.dataSource.query(
      `UPDATE ai_job SET status = 'queued', run_after = $2, error = $3,
              attempts = CASE WHEN $4::boolean THEN GREATEST(attempts - 1, 0) ELSE attempts END
        WHERE id = $1`,
      [job.id, runAfter, error, keepTry],
    );
  }

  // ------------------------------------------------------------------ the CLI

  /**
   * One CLI call of a job: counted in ai_usage (background calls against the budget), no tools, one
   * turn; the answer must be one JSON object (AiFormatError otherwise).
   */
  async askJson(job: AiJobRow, system: string, text: string): Promise<Record<string, any>> {
    const background = job.priority !== AiPriority.INTERACTIVE;
    await this.dataSource.query(
      `INSERT INTO ai_usage (day, background_calls, interactive_calls) VALUES (current_date, $1, $2)
       ON CONFLICT (day) DO UPDATE SET background_calls = ai_usage.background_calls + $1,
                                       interactive_calls = ai_usage.interactive_calls + $2`,
      [background ? 1 : 0, background ? 0 : 1],
    );
    this.inCli++;
    let answer: string;
    try {
      const result = await this.claude.run({
        system,
        content: [{ type: 'text', text }],
        model: AI.model,
        effort: AI.effort,
        timeoutSec: AI.timeoutSec,
        maxTurns: 1,
      });
      answer = result.text;
      this.lastModel.set(job.id, result.model ?? AI.model);
    } finally {
      this.inCli--;
    }
    const parsed = parseJsonObject(answer);
    if (!parsed) throw new AiFormatError('ИИ ответил не по формату (нет JSON)');
    return parsed;
  }

  // ------------------------------------------------------------------ budget and pause

  async backgroundCallsToday(): Promise<number> {
    const rows = await this.dataSource.query(`SELECT background_calls FROM ai_usage WHERE day = current_date`);
    return Number(rows[0]?.background_calls ?? 0);
  }

  /** The pause in force, if any. */
  async pause(): Promise<{ until: Date; reason: string } | null> {
    const rows = await this.dataSource.query(
      `SELECT paused_until, pause_reason FROM ai_usage WHERE paused_until > now() ORDER BY paused_until DESC LIMIT 1`,
    );
    return rows[0] ? { until: new Date(rows[0].paused_until), reason: rows[0].pause_reason || 'пауза' } : null;
  }

  /** Throws AiPausedError while the AI is paused. */
  async assertNotPaused(): Promise<void> {
    const pause = await this.pause();
    if (pause) throw new AiPausedError(pause.until, pause.reason);
  }

  private async setPause(minutes: number, reason: string, limitHit = false): Promise<Date> {
    const rows = returnedRows(
      await this.dataSource.query(
        `INSERT INTO ai_usage (day, paused_until, pause_reason, limit_hits)
         VALUES (current_date, now() + make_interval(mins => $1::int), $2, $3)
         ON CONFLICT (day) DO UPDATE SET paused_until = GREATEST(COALESCE(ai_usage.paused_until, now()), EXCLUDED.paused_until),
                                         pause_reason = EXCLUDED.pause_reason,
                                         limit_hits = ai_usage.limit_hits + EXCLUDED.limit_hits
         RETURNING paused_until`,
        [minutes, reason.slice(0, 255), limitHit ? 1 : 0],
      ),
    );
    return rows[0]?.paused_until ? new Date(rows[0].paused_until) : new Date(Date.now() + minutes * 60_000);
  }

  // ------------------------------------------------------------------ status, cleanup

  /** GET /ai/status: the switches, the budget, the pause, the queue and the CLI. */
  async status(): Promise<Record<string, any>> {
    const [usage] = await this.dataSource.query(`SELECT * FROM ai_usage WHERE day = current_date`);
    const queue = await this.dataSource.query(
      `SELECT status, priority, count(*)::int AS n FROM ai_job
        WHERE status IN ('queued', 'running') OR finished_at >= current_date GROUP BY status, priority`,
    );
    const errors = await this.dataSource.query(
      `SELECT id, kind, entity, entity_id, status, attempts, LEFT(error, 300) AS error, COALESCE(finished_at, started_at, created_at) AS at
         FROM ai_job WHERE error IS NOT NULL ORDER BY COALESCE(finished_at, started_at, created_at) DESC LIMIT 5`,
    );
    const pause = await this.pause();
    const count = (status: string, priority?: number) =>
      queue
        .filter((r: any) => r.status === status && (priority === undefined || Number(r.priority) === priority))
        .reduce((sum: number, r: any) => sum + Number(r.n), 0);
    return {
      features: AI.features(),
      model: AI.model,
      worker_sec: AI.workerSec,
      budget: {
        daily: AI.dailyBudget,
        background_used: Number(usage?.background_calls ?? 0),
        interactive_used: Number(usage?.interactive_calls ?? 0),
        limit_hits: Number(usage?.limit_hits ?? 0),
      },
      paused_until: pause?.until ?? null,
      pause_reason: pause?.reason ?? null,
      queue: {
        queued: count('queued'),
        queued_interactive: count('queued', AiPriority.INTERACTIVE),
        queued_event: count('queued', AiPriority.EVENT),
        queued_nightly: count('queued', AiPriority.NIGHTLY),
        running: count('running'),
        done_today: count('done'),
        failed_today: count('failed'),
      },
      worker: { interactive: this.active.interactive, background: this.active.background },
      cli: claudeCliLoad(),
      last_errors: errors,
    };
  }

  /** Once a day: finished jobs older than AI_JOBS_KEEP_DAYS, usage rows older than a year. */
  private async cleanup(): Promise<void> {
    const today = new Date().toDateString();
    if (this.cleanedOn === today) return;
    this.cleanedOn = today;
    await this.dataSource.query(
      `DELETE FROM ai_job WHERE status IN ('done', 'failed', 'skipped') AND finished_at < now() - make_interval(days => $1::int)`,
      [AI.keepDays],
    );
    await this.dataSource.query(`DELETE FROM ai_usage WHERE day < current_date - 400`);
  }
}
