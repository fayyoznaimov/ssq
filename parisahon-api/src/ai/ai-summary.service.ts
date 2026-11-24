import { BadRequestException, Injectable, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { AI, AiPriority, PROMPT_VERSION } from './ai.config';
import { AiFormatError, AiJobRow, AiOutcome, AiPausedError, AiQueueService, sha256 } from './ai-queue.service';
import { ChatMessage, dealNotes, loadDeal, messagesByIds, openTasks, recentMessages } from './ai-conversation';
import { DealSummary, OrderParamKey, SUMMARY_SYSTEM, cleanSummary, looksLikeSummary, summaryPrompt } from './ai-prompts';
import { dealItems, latestParams } from './ai-items';

export interface SummaryState {
  /** none: never made; stale: made for older data; queued / running: being made; done; failed; empty: nothing to summarise */
  status: 'none' | 'stale' | 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'empty';
  /** the summary is for the current data of the deal */
  fresh: boolean;
  /** answered from the cache, no new CLI call */
  cached?: boolean;
  job_id: number | null;
  made_at: Date | null;
  data: DealSummary | null;
  error: string | null;
}

/**
 * «Сводка сделки» (POST /deals/:id/ai/summary, the bot tool deal_summary): what the client wants, what
 * was promised, the open questions and the next step, with the ids of the messages it is based on.
 *  - The input is the latest 40 messages, the latest 10 internal notes, the open tasks, the open
 *    questions and promises, the order parameters and the deal itself; its hash is the cache key: the
 *    same data gives the stored summary, no CLI call.
 *  - A reader without the "mail" right gets a summary made without the letters (another input, another
 *    cache entry), so nothing of a letter reaches them.
 *  - A person's request (priority 0) takes a free CLI slot at once; at most AI_INTERACTIVE_PER_HOUR new
 *    summaries per user and hour; during a pause (usage limit) it answers 503 with the time.
 */
@Injectable()
export class AiSummaryService implements OnModuleInit {
  private readonly perUser = new Map<number, number[]>();

  constructor(
    private dataSource: DataSource,
    private queue: AiQueueService,
  ) {}

  onModuleInit(): void {
    this.queue.register('summary', (job) => this.run(job));
  }

  /** What the summary would be asked with now. */
  private async currentInput(dealId: number, withMail: boolean) {
    const deal = await loadDeal(this.dataSource, dealId);
    if (!deal) return null;
    const messages = await recentMessages(this.dataSource, dealId, withMail, 40);
    const notes = await dealNotes(this.dataSource, dealId, 10);
    const tasks = await openTasks(this.dataSource, dealId, 10);
    const items = await dealItems(this.dataSource, dealId, withMail, ['open'], 20);
    const params = await latestParams(this.dataSource, dealId, withMail);
    const hash = sha256({
      v: PROMPT_VERSION.summary,
      deal: [deal.id, deal.label, deal.stage, deal.company, String(deal.budget ?? ''), deal.products],
      mail: withMail,
      messages: messages.map((m) => [m.id, m.text]),
      notes: notes.map((n) => [n.id, n.text]),
      tasks: tasks.map((t) => [t.id, t.label, t.due ? t.due.getTime() : null]),
      items: items.map((i) => [i.id, i.text, i.due_at ? i.due_at.getTime() : null]),
      params: params.map((p) => [p.key, p.value]),
    });
    return {
      hash,
      deal,
      messages,
      input: { deal_id: dealId, mail: withMail, event_ids: messages.map((m) => m.id), note_ids: notes.map((n) => n.id) },
    };
  }

  /** The summary of the deal for this reader, made now if needed (waits up to `waitMs`). The caller checked the access. */
  async request(user: AuthUser, dealId: number, waitMs = AI.summaryWaitSec * 1000): Promise<SummaryState> {
    if (!AI.summary) throw new ServiceUnavailableException('ИИ-сводка выключена администратором');
    const withMail = new Access(user).canReadMail;
    const current = await this.currentInput(dealId, withMail);
    if (!current) throw new NotFoundException(`Deal ${dealId} not found`);

    let job = await this.queue.find('summary', current.hash);
    if (job?.status === 'done') return { ...this.state(job, true), cached: true };
    if (!current.messages.length) {
      return { status: 'empty', fresh: true, job_id: null, made_at: null, data: null, error: 'В сделке нет переписки с клиентом: сводке не из чего строиться' };
    }
    try {
      await this.queue.assertNotPaused();
    } catch (error) {
      if (error instanceof AiPausedError) throw new ServiceUnavailableException(error.message);
      throw error;
    }
    if (!job) {
      this.limit(user.sub);
      ({ job } = await this.queue.enqueue({
        kind: 'summary',
        entity: 'deal',
        entityId: dealId,
        inputHash: current.hash,
        input: current.input,
        priority: AiPriority.INTERACTIVE,
        promptVersion: PROMPT_VERSION.summary,
        requestedBy: user.sub,
      }));
    } else if (job.status === 'failed' || job.status === 'skipped') {
      // asked again by a person: one more round of tries for the same data
      this.limit(user.sub);
      await this.queue.retry(job.id);
    }
    const finished = (await this.queue.wait(job.id, waitMs)) ?? job;
    return { ...this.state(finished, true), cached: false };
  }

  /** The summary shown on the deal page: the one for the current data, else the latest one (stale). */
  async view(dealId: number, withMail: boolean): Promise<SummaryState> {
    const current = await this.currentInput(dealId, withMail);
    const job = current ? await this.queue.find('summary', current.hash) : null;
    if (job?.status === 'done') return this.state(job, true);
    const last: AiJobRow | undefined = (
      await this.dataSource.query(
        `SELECT * FROM ai_job WHERE kind = 'summary' AND entity = 'deal' AND entity_id = $1 AND status = 'done'
            AND input->>'mail' = $2 ORDER BY finished_at DESC, id DESC LIMIT 1`,
        [dealId, String(withMail)],
      )
    )[0];
    const status: SummaryState['status'] = job ? job.status : last ? 'stale' : 'none';
    return {
      status,
      fresh: false,
      job_id: job?.id ?? null,
      made_at: last?.finished_at ?? null,
      data: (last?.result?.summary as DealSummary) ?? null,
      error: job?.status === 'failed' ? 'Не удалось получить сводку, попробуйте ещё раз' : null,
    };
  }

  private state(job: AiJobRow, fresh: boolean): SummaryState {
    return {
      status: job.status,
      fresh,
      job_id: job.id,
      made_at: job.finished_at ?? null,
      data: job.status === 'done' ? ((job.result?.summary as DealSummary) ?? null) : null,
      error:
        job.status === 'failed'
          ? 'Не удалось получить сводку, попробуйте ещё раз'
          : job.status === 'skipped'
            ? job.error || 'Сводка не нужна'
            : null,
    };
  }

  private limit(userId: number): void {
    const now = Date.now();
    const recent = (this.perUser.get(userId) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= AI.perUserHour) throw new BadRequestException('Лимит ИИ-сводок на этот час исчерпан, попробуйте позже');
    recent.push(now);
    this.perUser.set(userId, recent);
  }

  // ------------------------------------------------------------------ the job

  private async run(job: AiJobRow): Promise<AiOutcome> {
    const dealId = job.entity_id;
    const withMail = job.input?.mail === true;
    const deal = await loadDeal(this.dataSource, dealId);
    if (!deal) return { skipped: 'сделка удалена' };
    let messages: ChatMessage[] = await messagesByIds(this.dataSource, dealId, job.input?.event_ids ?? [], 800);
    if (!withMail) messages = messages.filter((m) => m.channel !== 'email');
    if (!messages.length) return { skipped: 'в сделке нет переписки' };
    const noteIds: number[] = Array.isArray(job.input?.note_ids) ? job.input.note_ids : [];
    const notes = noteIds.length ? await dealNotes(this.dataSource, dealId, noteIds.length, 500, noteIds) : [];
    const tasks = await openTasks(this.dataSource, dealId, 10);
    const items = await dealItems(this.dataSource, dealId, withMail, ['open'], 20);
    const params = Object.fromEntries((await latestParams(this.dataSource, dealId, withMail)).map((p) => [p.key, p.value])) as Partial<
      Record<OrderParamKey, string>
    >;
    const raw = await this.queue.askJson(
      job,
      SUMMARY_SYSTEM,
      summaryPrompt({ now: new Date(), deal, messages, notes, tasks, openItems: items, params }),
    );
    if (!looksLikeSummary(raw)) throw new AiFormatError('ИИ ответил не по формату сводки');
    const summary = cleanSummary(raw, new Set([...messages.map((m) => m.id), ...notes.map((n) => n.id)]));
    return { result: { summary, mail: withMail, message_ids: messages.map((m) => m.id) } };
  }
}
