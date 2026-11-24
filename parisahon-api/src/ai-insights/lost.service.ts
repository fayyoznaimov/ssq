import { BadRequestException, Injectable, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { AiPriority } from '../ai/ai.config';
import { AiFormatError, AiJobRow, AiOutcome, AiPausedError, AiQueueService, sha256 } from '../ai/ai-queue.service';
import { ChatMessage, dealNotes, loadDeal, messageRefs, messagesByIds, recentMessages } from '../ai/ai-conversation';
import { recentFlags } from '../ai/ai-items';
import { FLAG_LABELS } from '../ai/ai-prompts';
import { LOST_REASONS } from '../history/lost-reasons';
import { AI2, PROMPT_VERSION_2 } from './ai-insights.config';
import { HourlyLimit } from './insights-common';
import { LOST_SYSTEM, LostProposal, cleanLost, looksLikeLost, lostPrompt } from './insights-prompts';

export interface LostState {
  /** none: never asked; queued / running: being made; done; failed; skipped; empty: no conversation to read */
  status: 'none' | 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'empty' | 'not_lost';
  cached?: boolean;
  job_id: number | null;
  data: LostProposal | null;
  /** the message of the quote: who, when, where, a short excerpt */
  ref: { at: Date; from: string; channel: string; excerpt: string } | null;
  error: string | null;
}

/**
 * «Причина проигрыша»: a deal moved to the stage of kind `lost` — the reason form (LostReasonModal of the web)
 * asks the AI for the reason: one of the list of src/history/lost-reasons.ts, a short comment and the client's
 * words it is based on (checked to be in that message). The manager confirms it with the usual «Сохранить
 * причину» (PATCH /deals/:id/lost): the AI never writes the reason itself.
 *  - The input: the latest 40 messages (letters only with the reader's «Почта» right), the latest 10 notes and
 *    the signals the turn analyses found (дорого, конкурент, скидка, жалоба); its hash is the cache key: the same
 *    data gives the stored proposal, no CLI call.
 *  - A person's request (priority 0), like the deal summary: AI_INTERACTIVE_PER_HOUR, 503 during the pause.
 */
@Injectable()
export class AiLostService implements OnModuleInit {
  private readonly limit = new HourlyLimit('причина проигрыша');

  constructor(
    private dataSource: DataSource,
    private queue: AiQueueService,
  ) {}

  onModuleInit(): void {
    this.queue.register('lost', (job) => this.run(job));
  }

  private async isLost(dealId: number): Promise<boolean> {
    const [row] = await this.dataSource.query(
      `SELECT s.kind FROM deal d LEFT JOIN deal_stage s ON s.id = d.stage_id WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [dealId],
    );
    if (!row) throw new NotFoundException(`Deal ${dealId} not found`);
    return row.kind === 'lost';
  }

  private async currentInput(dealId: number, withMail: boolean) {
    const messages = await recentMessages(this.dataSource, dealId, withMail, 40, 800);
    const notes = await dealNotes(this.dataSource, dealId, 10, 500);
    const flags = await recentFlags(this.dataSource, dealId, withMail, 365);
    const signals = flags.map((f) => `${f.flag === 'price_objection' ? 'Дорого' : FLAG_LABELS[f.flag] ?? f.flag} × ${f.count}`);
    // The proposal is shared by every reader of the same data: «mail» is set only when a letter (or a turn read
    // with letters) is really in the input, so a reader without the «Почта» right sees the proposal of a deal
    // without letters made by a colleague, and never one that saw a letter.
    const mail =
      withMail &&
      (messages.some((m) => m.channel === 'email') ||
        (await this.dataSource.query(`SELECT 1 FROM conversation_turn WHERE deal_id = $1 AND has_email LIMIT 1`, [dealId])).length > 0);
    const hash = sha256({
      v: PROMPT_VERSION_2.lost,
      deal: dealId,
      mail,
      messages: messages.map((m) => [m.id, m.text]),
      notes: notes.map((n) => [n.id, n.text]),
      signals,
      reasons: LOST_REASONS,
    });
    return { hash, messages, notes, signals, input: { deal_id: dealId, mail, event_ids: messages.map((m) => m.id), note_ids: notes.map((n) => n.id), signals } };
  }

  private async state(job: AiJobRow, dealId: number, withMail: boolean): Promise<LostState> {
    const data = job.status === 'done' ? ((job.result?.proposal as LostProposal) ?? null) : null;
    let ref: LostState['ref'] = null;
    if (data?.event_id) {
      const refs = await messageRefs(this.dataSource, dealId, [data.event_id], withMail);
      const r = refs[data.event_id];
      if (r) ref = { at: r.at, from: r.from, channel: r.channel, excerpt: r.excerpt };
    }
    return {
      status: job.status,
      job_id: job.id,
      data,
      ref,
      error: job.status === 'failed' ? 'ИИ не смог предложить причину, выберите её сами' : job.status === 'skipped' ? job.error || null : null,
    };
  }

  /** GET /deals/:id/ai/lost-reason: the proposal for the current data, if one was made (no new CLI call). */
  async view(user: AuthUser, dealId: number): Promise<LostState & { enabled: boolean }> {
    if (!AI2.lostReason) return { enabled: false, status: 'none', job_id: null, data: null, ref: null, error: null };
    if (!(await this.isLost(dealId))) return { enabled: true, status: 'not_lost', job_id: null, data: null, ref: null, error: null };
    const withMail = new Access(user).canReadMail;
    const current = await this.currentInput(dealId, withMail);
    const job = await this.queue.find('lost', current.hash);
    if (!job) return { enabled: true, status: 'none', job_id: null, data: null, ref: null, error: null };
    return { enabled: true, ...(await this.state(job, dealId, withMail)) };
  }

  /** POST /deals/:id/ai/lost-reason: the AI's proposal, made now if needed (waits AI_LOST_WAIT_SEC, then the form polls). */
  async request(user: AuthUser, dealId: number, waitMs = AI2.lostWaitSec * 1000): Promise<LostState> {
    if (!AI2.lostReason) throw new ServiceUnavailableException('ИИ-подсказка причины проигрыша выключена администратором');
    if (!(await this.isLost(dealId))) throw new BadRequestException('Причину проигрыша ИИ предлагает только для сделки в этапе «Закрыто и не реализовано»');
    const withMail = new Access(user).canReadMail;
    const current = await this.currentInput(dealId, withMail);
    let job = await this.queue.find('lost', current.hash);
    if (job?.status === 'done') return { ...(await this.state(job, dealId, withMail)), cached: true };
    if (!current.messages.length && !current.notes.length) {
      return { status: 'empty', job_id: null, data: null, ref: null, error: 'В сделке нет переписки и заметок: ИИ не из чего понять причину' };
    }
    try {
      await this.queue.assertNotPaused();
    } catch (error) {
      if (error instanceof AiPausedError) throw new ServiceUnavailableException(error.message);
      throw error;
    }
    if (!job) {
      this.limit.take(user.sub);
      ({ job } = await this.queue.enqueue({
        kind: 'lost',
        entity: 'deal',
        entityId: dealId,
        inputHash: current.hash,
        input: current.input,
        priority: AiPriority.INTERACTIVE,
        promptVersion: PROMPT_VERSION_2.lost,
        requestedBy: user.sub,
      }));
    } else if (job.status === 'failed' || job.status === 'skipped') {
      this.limit.take(user.sub);
      await this.queue.retry(job.id);
    }
    const finished = (await this.queue.wait(job.id, waitMs)) ?? job;
    return { ...(await this.state(finished, dealId, withMail)), cached: false };
  }

  private async run(job: AiJobRow): Promise<AiOutcome> {
    const dealId = job.entity_id;
    const withMail = job.input?.mail === true;
    const deal = await loadDeal(this.dataSource, dealId);
    if (!deal) return { skipped: 'сделка удалена' };
    let messages: ChatMessage[] = await messagesByIds(this.dataSource, dealId, job.input?.event_ids ?? [], 800);
    if (!withMail) messages = messages.filter((m) => m.channel !== 'email');
    const noteIds: number[] = Array.isArray(job.input?.note_ids) ? job.input.note_ids : [];
    const notes = noteIds.length ? await dealNotes(this.dataSource, dealId, noteIds.length, 500, noteIds) : [];
    if (!messages.length && !notes.length) return { skipped: 'в сделке нет переписки и заметок' };
    const signals: string[] = Array.isArray(job.input?.signals) ? job.input.signals.map(String).slice(0, 10) : [];
    const raw = await this.queue.askJson(job, LOST_SYSTEM, lostPrompt({ now: new Date(), deal, messages, notes, signals, reasons: LOST_REASONS }));
    if (!looksLikeLost(raw)) throw new AiFormatError('ИИ ответил не по формату причины проигрыша');
    return { result: { proposal: cleanLost(raw, LOST_REASONS, messages, notes) } };
  }
}

