import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkSchedule } from '../analytics/control.service';
import { endOfWorkingDay } from '../automation/autopilot.service';
import { AI, AI_QUESTION_TASK, AI_TASK_PREFIX, AiPriority, PROMPT_VERSION } from './ai.config';
import { AiFormatError, AiJobRow, AiOutcome, AiQueueService, returnedRows, sha256 } from './ai-queue.service';
import { CHAT_EVENT_TYPES, ChatMessage, loadDeal, messagesAfter, messagesBefore, messagesByIds } from './ai-conversation';
import { OpenItem, TURN_SYSTEM, TurnAnalysis, cleanTurn, looksLikeTurn, parseDue, sameText, turnPrompt } from './ai-prompts';
import { AiTaskService } from './ai-task.service';

/**
 * «Разбор хода»: a turn of a deal's conversation — the client wrote (Telegram, WhatsApp, e-mail) and
 * the manager answered — goes to the AI once, as a background job:
 *  - the turn is complete when the client writes again after the manager's answer, or AI_TURN_QUIET_MIN
 *    (10) minutes passed after the manager's last message (he may answer in several messages);
 *  - only open deals (closed_at is empty), only messages of the last AI_ACTIVE_DAYS; a deal never
 *    analysed starts with its latest turn (the earlier messages are its context);
 *  - messages of the manager alone (no new client message) are analysed only while the deal has open
 *    questions or promises: they may answer or fulfil them;
 *  - one CLI call returns the unanswered questions, the promises with dates, the order parameters, the
 *    flags, the language and a one-line summary (ai-prompts.ts); stored in conversation_turn, the
 *    questions and promises in conversation_item.
 * Then the features:
 *  - «Вопрос без ответа»: an open question waits AI_QUESTION_SLA_MIN working minutes on the deal page,
 *    then becomes ONE task «Авто (ИИ): ответьте клиенту на вопрос: …» for the deal (AI_QUESTION_TASKS);
 *  - «Обещания → задачи»: the manager's promise with a date becomes a task «Авто (ИИ): <обещание>» due at
 *    that time, at most AI_PROMISE_TASKS_PER_DAY (2) per deal and day (AI_PROMISE_TASKS);
 *  - a later analysis that sees a question answered or a promise fulfilled closes it and its task; the
 *    manager closing the task closes its questions / promises; «Снять» on the deal page dismisses one.
 */
@Injectable()
export class AiTurnService implements OnModuleInit {
  private readonly logger = new Logger('AiTurns');
  /** deals whose new messages need nothing for now, by the id of their newest message */
  private readonly idle = new Map<number, number>();

  constructor(
    private dataSource: DataSource,
    private queue: AiQueueService,
    private tasks: AiTaskService,
  ) {}

  onModuleInit(): void {
    this.queue.register('turn', (job) => this.run(job));
    this.queue.addTicker('turn detector', () => this.detect());
    this.queue.addTicker('closed tasks', () => this.syncClosedTasks());
    this.queue.addTicker('question tasks', () => this.questionTasks());
  }

  // ------------------------------------------------------------------ detection

  /**
   * Open deals with messages after their last analysed turn and no turn job waiting, the most recently
   * active first. A deal whose newest message is the one it was found idle with is passed over without
   * reading its messages (the detector runs every AI_WORKER_SEC).
   */
  async detect(now = new Date()): Promise<number> {
    if (!AI.turns) return 0;
    const params: unknown[] = [CHAT_EVENT_TYPES, AI.activeDays];
    let prefix = '';
    if (AI.testDealPrefix) {
      params.push(`${likeEscape(AI.testDealPrefix)}%`);
      prefix = `AND d.label LIKE $${params.length}`;
    }
    const deals: { id: number; done_to: number; newest: number }[] = await this.dataSource.query(
      `SELECT x.id, x.done_to, n.newest FROM (
         SELECT d.id, COALESCE((SELECT MAX(t.to_event_id) FROM conversation_turn t WHERE t.deal_id = d.id), 0) AS done_to
           FROM deal d
          WHERE d.deleted_at IS NULL AND d.closed_at IS NULL ${prefix}
            AND NOT EXISTS (SELECT 1 FROM ai_job j WHERE j.kind = 'turn' AND j.entity = 'deal' AND j.entity_id = d.id
                                                     AND j.status IN ('queued', 'running'))
       ) x
       CROSS JOIN LATERAL (SELECT MAX(e.id) AS newest, MAX(e.created_at) AS last_at FROM event e
                            WHERE e.deal_id = x.id AND e.type = ANY($1) AND e.id > x.done_to
                              AND e.created_at > now() - make_interval(days => $2::int)) n
       WHERE n.newest IS NOT NULL
       ORDER BY n.last_at DESC, x.id LIMIT 300`,
      params,
    );
    let queued = 0;
    const seen = new Set<number>();
    for (const deal of deals) {
      const dealId = Number(deal.id);
      seen.add(dealId);
      if (this.idle.get(dealId) === Number(deal.newest)) continue;
      try {
        if (await this.consider(dealId, Number(deal.done_to), Number(deal.newest), now)) queued++;
      } catch (error) {
        this.logger.warn(`deal ${deal.id}: ${(error as Error).message}`);
      }
    }
    // deals that are closed, analysed or quiet now are forgotten
    for (const dealId of [...this.idle.keys()]) if (!seen.has(dealId)) this.idle.delete(dealId);
    return queued;
  }

  /**
   * Finds the latest complete turn after `doneTo` and queues it; true when a new job was queued.
   * `newest`: the largest id of the deal's messages after `doneTo` (the detector's), the idle mark.
   */
  private async consider(dealId: number, doneTo: number, newest: number, now: Date): Promise<boolean> {
    const messages = await messagesAfter(this.dataSource, dealId, doneTo, AI.activeDays, 80);
    if (!messages.length) {
      this.idle.set(dealId, newest); // only empty messages (no text, no files)
      return false;
    }

    let end = messages.length - 1;
    if (messages[end].from === 'client') {
      // the client wrote after the manager: the turn before these messages is complete
      while (end >= 0 && messages[end].from === 'client') end--;
      // only the client wrote: nothing to analyse until the manager answers («клиент ждёт ответа» is another process)
      if (end < 0) {
        this.idle.set(dealId, newest);
        return false;
      }
    } else if (now.getTime() - messages[end].at.getTime() < AI.quietMin * 60_000) {
      return false; // the manager may still be writing
    }
    let start = 0;
    if (doneTo === 0) {
      // never analysed: the latest turn only, the messages before it are context
      start = end;
      while (start > 0 && messages[start - 1].from === 'manager') start--;
      while (start > 0 && messages[start - 1].from === 'client') start--;
    }
    let turn = messages.slice(start, end + 1);
    if (turn.length > 40) turn = turn.slice(-40);

    const firstClient = turn.findIndex((m) => m.from === 'client');
    const answered = firstClient >= 0 && turn.slice(firstClient).some((m) => m.from === 'manager');
    if (!answered) {
      // the manager's messages alone: worth a call only when they may close something
      const open = await this.dataSource.query(`SELECT 1 FROM conversation_item WHERE deal_id = $1 AND status = 'open' LIMIT 1`, [dealId]);
      if (!open.length) {
        this.idle.set(dealId, newest);
        return false;
      }
    }

    const context = await messagesBefore(this.dataSource, dealId, turn[0], 8);
    const inputHash = sha256({
      v: PROMPT_VERSION.turn,
      deal: dealId,
      turn: turn.map((m) => [m.id, m.text]),
      context: context.map((m) => m.id),
    });
    const { job, created } = await this.queue.enqueue({
      kind: 'turn',
      entity: 'deal',
      entityId: dealId,
      inputHash,
      input: { deal_id: dealId, event_ids: turn.map((m) => m.id), context_ids: context.map((m) => m.id) },
      priority: AiPriority.EVENT,
      promptVersion: PROMPT_VERSION.turn,
    });
    if (created) {
      this.idle.delete(dealId);
      return true;
    }
    // the same input was asked before: never again. Its stored answer is used if the turn row is missing.
    if (job?.status === 'done' && job.result?.meta) await this.store(job, job.result as StoredTurn);
    else this.idle.set(dealId, newest);
    return false;
  }

  // ------------------------------------------------------------------ the job

  private async run(job: AiJobRow): Promise<AiOutcome> {
    const dealId = job.entity_id;
    const deal = await loadDeal(this.dataSource, dealId);
    if (!deal || deal.closed) return { skipped: 'сделка закрыта или удалена' };
    const turn = await messagesByIds(this.dataSource, dealId, job.input?.event_ids ?? []);
    if (!turn.length) return { skipped: 'сообщений хода больше нет в сделке' };
    const context = await messagesByIds(this.dataSource, dealId, job.input?.context_ids ?? [], 600);
    const openItems = await this.openItems(dealId);

    const raw = await this.queue.askJson(job, TURN_SYSTEM, turnPrompt({ now: new Date(), deal, context, turn, openItems }));
    if (!looksLikeTurn(raw)) throw new AiFormatError('ИИ ответил не по формату разбора хода');
    const analysis = cleanTurn(raw, {
      client: new Set(turn.filter((m) => m.from === 'client').map((m) => m.id)),
      turn: new Set(turn.map((m) => m.id)),
      openQuestions: new Set(openItems.filter((i) => i.kind === 'question').map((i) => i.id)),
      openPromises: new Set(openItems.filter((i) => i.kind === 'promise').map((i) => i.id)),
    });
    const result: StoredTurn = { ...analysis, meta: turnMeta(turn) };
    await this.store(job, result);
    return { result };
  }

  private async openItems(dealId: number): Promise<OpenItem[]> {
    const rows = await this.dataSource.query(
      `SELECT id, kind, who, text, due_at, due_has_time FROM conversation_item
        WHERE deal_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 20`,
      [dealId],
    );
    return rows.reverse().map((r: any) => ({
      id: Number(r.id),
      kind: r.kind,
      who: r.who,
      text: r.text,
      due_at: r.due_at ? new Date(r.due_at) : null,
      due_has_time: !!r.due_has_time,
    }));
  }

  /** The turn row, its questions and promises, the items it closes; then the tasks. Idempotent per turn. */
  private async store(job: AiJobRow, result: StoredTurn): Promise<void> {
    const dealId = job.entity_id;
    const meta = result.meta;
    const schedule = new WorkSchedule();
    const emailIds = new Set(meta.email_ids ?? []);
    const newPromises: { id: number; who: string; text: string; due_at: Date | null; has_email: boolean }[] = [];
    let closed: { id: number; kind: string; task_id: number | null }[] = [];
    let stored = false;

    await this.dataSource.transaction(async (m) => {
      const exists = await m.query(`SELECT 1 FROM deal WHERE id = $1 AND deleted_at IS NULL`, [dealId]);
      if (!exists.length) return;
      const inserted = returnedRows(
        await m.query(
          `INSERT INTO conversation_turn (deal_id, job_id, from_event_id, to_event_id, client_at, answered_at, channels, has_email,
                                          unanswered_questions, promises, order_params, flags, language, summary, prompt_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15)
           ON CONFLICT (deal_id, to_event_id) DO NOTHING RETURNING id`,
          [
            dealId,
            job.id,
            meta.from_event_id,
            meta.to_event_id,
            meta.client_at ? new Date(meta.client_at) : null,
            meta.answered_at ? new Date(meta.answered_at) : null,
            meta.channels.join(',').slice(0, 64),
            meta.has_email,
            JSON.stringify(result.unanswered_questions),
            JSON.stringify(result.promises),
            JSON.stringify(result.order_params),
            JSON.stringify(result.flags),
            result.language,
            result.summary || null,
            job.prompt_version,
          ],
        ),
      );
      const turnId = inserted[0]?.id;
      if (!turnId) return; // stored before
      stored = true;

      // first what this turn answered or fulfilled, then the new items
      const done = [...result.answered_items, ...result.fulfilled_items];
      if (done.length) {
        closed = returnedRows(
          await m.query(
            `UPDATE conversation_item
                SET status = 'done', closed_at = now(), close_reason = CASE WHEN kind = 'question' THEN 'answered' ELSE 'fulfilled' END
              WHERE deal_id = $1 AND status = 'open' AND id = ANY($2) RETURNING id, kind, task_id`,
            [dealId, done],
          ),
        );
      }
      // a question or promise said again (the client repeats the question) stays one item
      const open: { kind: string; who: string | null; text: string }[] = await m.query(
        `SELECT kind, who, text FROM conversation_item WHERE deal_id = $1 AND status = 'open'`,
        [dealId],
      );
      const known = (kind: string, who: string | null, text: string) =>
        open.some((o) => o.kind === kind && (kind === 'question' || o.who === who) && sameText(o.text, text));

      for (const q of result.unanswered_questions) {
        if (known('question', null, q.text)) continue;
        await m.query(
          `INSERT INTO conversation_item (deal_id, turn_id, kind, text, event_id, has_email) VALUES ($1, $2, 'question', $3, $4, $5)`,
          [dealId, turnId, q.text.slice(0, 500), q.event_id, q.event_id ? emailIds.has(q.event_id) : meta.has_email],
        );
        open.push({ kind: 'question', who: null, text: q.text });
      }
      for (const p of result.promises) {
        if (known('promise', p.who, p.what)) continue;
        const due = parseDue(p.due, schedule.endMin);
        const hasEmail = p.event_id ? emailIds.has(p.event_id) : meta.has_email;
        const rows = returnedRows(
          await m.query(
            `INSERT INTO conversation_item (deal_id, turn_id, kind, who, text, event_id, has_email, due_at, due_has_time)
             VALUES ($1, $2, 'promise', $3, $4, $5, $6, $7, $8) RETURNING id`,
            [dealId, turnId, p.who, p.what.slice(0, 500), p.event_id, hasEmail, due?.at ?? null, due?.hasTime ?? false],
          ),
        );
        if (rows[0]) newPromises.push({ id: Number(rows[0].id), who: p.who, text: p.what, due_at: due?.at ?? null, has_email: hasEmail });
        open.push({ kind: 'promise', who: p.who, text: p.what });
      }
    });
    if (!stored) return;

    await this.tasks.closeAllIfDone(
      closed.filter((c) => c.kind === 'question').map((c) => c.task_id),
      'Клиенту ответили (по разбору ИИ)',
    );
    await this.tasks.closeAllIfDone(
      closed.filter((c) => c.kind === 'promise').map((c) => c.task_id),
      'Обещание выполнено (по разбору ИИ)',
    );
    await this.promiseTasks(dealId, newPromises);
    this.tasks.changed(dealId);
  }

  // ------------------------------------------------------------------ features

  /** «Обещания → задачи»: the manager's promises with a date ahead, at most N tasks per deal and day. */
  private async promiseTasks(
    dealId: number,
    promises: { id: number; who: string; text: string; due_at: Date | null; has_email: boolean }[],
    now = new Date(),
  ): Promise<void> {
    if (!AI.promiseTasks) return;
    const horizon = now.getTime() + 60 * 86_400_000;
    const candidates = promises.filter((p) => p.who === 'manager' && p.due_at && p.due_at.getTime() > now.getTime() && p.due_at.getTime() < horizon);
    if (!candidates.length) return;
    // the cap counts the promise tasks of the AI made today in the deal (also those already closed or deleted from the items)
    const [{ n }] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM task
        WHERE deal_id = $1 AND created_at >= current_date AND label LIKE $2 AND label NOT LIKE $3`,
      [dealId, `${likeEscape(AI_TASK_PREFIX)}%`, `${likeEscape(AI_QUESTION_TASK)}%`],
    );
    let left = AI.promiseTasksPerDay - Number(n);
    for (const promise of candidates) {
      // a task is seen by everybody who sees the deal: nothing of a letter in its label (the «Почта» right)
      const label = (promise.has_email ? `${AI_TASK_PREFIX}выполните обещание из письма клиенту` : `${AI_TASK_PREFIX}${promise.text}`).slice(0, 255);
      // the same promise has an open task already (said again, or its analysis stored again): one task
      const [same] = await this.dataSource.query(
        `SELECT id FROM task WHERE deal_id = $1 AND closed_at IS NULL AND label = $2 ORDER BY id DESC LIMIT 1`,
        [dealId, label],
      );
      if (same) {
        await this.dataSource.query(
          `UPDATE conversation_item SET task_id = $2, tasked_at = (SELECT created_at FROM task WHERE id = $2) WHERE id = $1`,
          [promise.id, same.id],
        );
        continue;
      }
      if (left <= 0) continue;
      const task = await this.tasks.create(dealId, label, promise.due_at);
      if (!task) return; // nobody is responsible for the deal
      await this.dataSource.query(`UPDATE conversation_item SET task_id = $2, tasked_at = now() WHERE id = $1`, [promise.id, task.id]);
      left--;
    }
  }

  /**
   * «Вопрос без ответа»: the open questions of a deal, the oldest waiting AI_QUESTION_SLA_MIN working
   * minutes, become one task (none while another such task of the deal is open).
   */
  async questionTasks(now = new Date()): Promise<number> {
    if (!AI.questionTasks) return 0;
    const rows: { deal_id: number; ids: number[]; first_text: string; first_email: boolean; since: Date; n: number }[] =
      await this.dataSource.query(
        `SELECT i.deal_id, array_agg(i.id ORDER BY i.id) AS ids, (array_agg(i.text ORDER BY i.id))[1] AS first_text,
                (array_agg(i.has_email ORDER BY i.id))[1] AS first_email, MIN(i.created_at) AS since, count(*)::int AS n
           FROM conversation_item i
           JOIN deal d ON d.id = i.deal_id AND d.deleted_at IS NULL AND d.closed_at IS NULL AND d.agent_id IS NOT NULL
          WHERE i.kind = 'question' AND i.status = 'open' AND i.tasked_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM task t WHERE t.deal_id = i.deal_id AND t.closed_at IS NULL AND t.label LIKE $1)
          GROUP BY i.deal_id ORDER BY i.deal_id LIMIT 50`,
        [`${likeEscape(AI_QUESTION_TASK)}%`],
      );
    const schedule = new WorkSchedule();
    let created = 0;
    for (const row of rows) {
      const slaSec = AI.questionSlaMin * 60;
      if (slaSec > 0 && schedule.seconds(new Date(row.since), now) < slaSec) continue;
      const more = row.n > 1 ? ` (и ещё ${row.n - 1})` : '';
      // the question of a letter is not quoted: the task is seen by people without the «Почта» right too
      const label = row.first_email ? `${AI_QUESTION_TASK} из письма${more}` : `${AI_QUESTION_TASK}: «${row.first_text}»${more}`;
      const task = await this.tasks.create(row.deal_id, label, endOfWorkingDay(schedule, now, 3600));
      if (!task) continue;
      await this.dataSource.query(`UPDATE conversation_item SET task_id = $2, tasked_at = now() WHERE id = ANY($1)`, [row.ids, task.id]);
      this.tasks.changed(row.deal_id);
      created++;
    }
    return created;
  }

  /** The manager closed a task of the AI: its questions and promises are done. */
  async syncClosedTasks(): Promise<number> {
    if (!AI.turns) return 0;
    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE conversation_item i SET status = 'done', close_reason = 'task_closed', closed_at = now()
           FROM task t WHERE t.id = i.task_id AND t.closed_at IS NOT NULL AND i.status = 'open'
         RETURNING i.deal_id`,
      ),
    );
    for (const dealId of new Set(rows.map((r: any) => Number(r.deal_id)))) this.tasks.changed(dealId);
    return rows.length;
  }
}

/** What a turn job stores in ai_job.result: the checked analysis and where the turn is. */
export type StoredTurn = TurnAnalysis & {
  meta: {
    from_event_id: number;
    to_event_id: number;
    client_at: string | null;
    answered_at: string | null;
    channels: string[];
    has_email: boolean;
    email_ids: number[];
  };
};

function turnMeta(turn: ChatMessage[]): StoredTurn['meta'] {
  const client = turn.find((m) => m.from === 'client');
  const manager = [...turn].reverse().find((m) => m.from === 'manager');
  const channels = [...new Set(turn.map((m) => m.channel))];
  return {
    from_event_id: turn[0].id,
    // the largest id: a letter synced late (an old date, a new id) is covered too
    to_event_id: Math.max(...turn.map((m) => m.id)),
    client_at: client ? client.at.toISOString() : null,
    answered_at: manager ? manager.at.toISOString() : null,
    channels,
    has_email: channels.includes('email'),
    email_ids: turn.filter((m) => m.channel === 'email').map((m) => m.id),
  };
}

/** A text for LIKE: its own %, _ and \ match only themselves. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
