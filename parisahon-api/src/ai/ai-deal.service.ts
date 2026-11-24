import { HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { DealService } from '../deal/deal.service';
import { UpdateDealDto } from '../deal/dto/update.deal.dto';
import { User } from '../user/user.entity';
import { AI } from './ai.config';
import { AiQueueService, returnedRows } from './ai-queue.service';
import { AiSummaryService, SummaryState } from './ai-summary.service';
import { AiTaskService } from './ai-task.service';
import { loadDeal, messageRefs } from './ai-conversation';
import { dealItems, latestParams, recentFlags } from './ai-items';
import { FLAG_LABELS, ORDER_PARAMS, OrderParamKey, localStamp, sameText } from './ai-prompts';

interface ParamTarget {
  filler_id: number;
  field: string;
  deal_filler_id: number | null;
  /** the value the deal has in this field now (a manual value is never overwritten) */
  current: string | null;
}

/**
 * The «ИИ» block of the deal page (GET /deals/:id/ai) and its actions, and the bot tool:
 *  - the summary, the open questions and promises, the order parameters with the deal field each one
 *    goes to, the flags and the last turns; references to the messages with a short excerpt;
 *  - «Принять» (POST /deals/:id/ai/accept): parameters into the deal's custom fields named like them
 *    («Размер», «Граммаж», «Цвет», ... — ORDER_PARAMS), only into empty fields, through DealService.update
 *    (the deal history shows the change); «Снять» (POST /deals/:id/ai/items/:item_id/dismiss).
 * A reader without the "mail" right sees nothing that comes from letters. The routes check the deal
 * right (DealAccess view / update); the bot tool checks it here.
 */
@Injectable()
export class AiDealService {
  constructor(
    private dataSource: DataSource,
    private queue: AiQueueService,
    private summaries: AiSummaryService,
    private tasks: AiTaskService,
    private deals: DealService,
  ) {}

  async view(user: AuthUser, dealId: number): Promise<Record<string, any>> {
    const features = AI.features();
    if (!AI.enabled) {
      return {
        enabled: false,
        features,
        can_update: false,
        summary: null,
        questions: [],
        promises: [],
        order_params: [],
        missing_fields: [],
        flags: [],
        turns: [],
        refs: {},
      };
    }
    const access = new Access(user);
    const withMail = access.canReadMail;
    const deal = await loadDeal(this.dataSource, dealId);
    if (!deal) throw new NotFoundException(`Deal ${dealId} not found`);
    const canUpdate = access.allowsDeal('update', deal.agent_id, deal.group_id);

    const items = await dealItems(this.dataSource, dealId, withMail, ['open'], 50);
    const params = await latestParams(this.dataSource, dealId, withMail);
    const targets = await this.paramTargets(dealId);
    const flags = await recentFlags(this.dataSource, dealId, withMail);
    const turns = await this.dataSource.query(
      `SELECT id, to_event_id, created_at, summary, language, channels FROM conversation_turn
        WHERE deal_id = $1 AND ($2::boolean OR NOT has_email) ORDER BY to_event_id DESC LIMIT 5`,
      [dealId, withMail],
    );
    const summary = AI.summary ? await this.summaries.view(dealId, withMail) : null;
    const pause = await this.queue.pause();
    // a turn of this deal waits for the AI or is being analysed now; the background budget of today is spent
    const [{ analysing }] = await this.dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM ai_job WHERE kind = 'turn' AND entity = 'deal' AND entity_id = $1
                                              AND status IN ('queued', 'running')) AS analysing`,
      [dealId],
    );
    const budgetSpent = AI.turns && (await this.queue.backgroundCallsToday()) >= AI.dailyBudget;

    const refIds = [
      ...items.map((i) => i.event_id),
      ...params.map((p) => p.event_id),
      ...turns.map((t: any) => Number(t.to_event_id)),
      ...(summary?.data
        ? [
            ...summary.data.client_wants_refs,
            ...summary.data.next_step_refs,
            ...summary.data.promised.map((p) => p.event_id),
            ...summary.data.open_questions.map((q) => q.event_id),
          ]
        : []),
    ].filter((id): id is number => Number.isInteger(id));
    const refs = await messageRefs(this.dataSource, dealId, refIds, withMail);

    return {
      enabled: true,
      features,
      can_update: canUpdate,
      paused_until: pause?.until ?? null,
      pause_reason: pause?.reason ?? null,
      deal_closed: deal.closed,
      analysing: !!analysing,
      budget_spent: budgetSpent,
      summary,
      questions: items
        .filter((i) => i.kind === 'question')
        .map((i) => ({ id: i.id, text: i.text, event_id: i.event_id, found_at: i.created_at, task_id: i.task_id, task_closed: i.task_closed })),
      promises: items
        .filter((i) => i.kind === 'promise')
        .map((i) => ({
          id: i.id,
          who: i.who,
          text: i.text,
          // "2026-11-25 18:00" (Tashkent) for the bot, the moment for the page
          due: i.due_at ? localStamp(i.due_at, i.due_has_time) : null,
          due_at: i.due_at,
          due_has_time: i.due_has_time,
          event_id: i.event_id,
          found_at: i.created_at,
          task_id: i.task_id,
          task_closed: i.task_closed,
        })),
      // state: ready (an empty field of the deal takes it), accepted (the field has this value),
      // filled (the field has another value, kept), no_field (the deal has no such field)
      order_params: params.map((p) => {
        const target = targets[p.key] ?? null;
        const state = !target ? 'no_field' : !target.current ? 'ready' : sameText(target.current, p.value) ? 'accepted' : 'filled';
        return { ...p, target, state, can_accept: canUpdate && state === 'ready' };
      }),
      // the deal fields to add (Настройки → Сделки) so that these parameters can go into the deal
      missing_fields: params.filter((p) => !targets[p.key]).map((p) => ORDER_PARAMS.find((o) => o.key === p.key)?.fields[0] ?? p.label),
      flags: flags.map((f) => ({ ...f, label: FLAG_LABELS[f.flag] ?? f.flag })),
      turns: turns.map((t: any) => ({
        id: Number(t.id),
        event_id: Number(t.to_event_id),
        at: t.created_at,
        summary: t.summary,
        language: t.language,
        channels: String(t.channels || '').split(',').filter(Boolean),
      })),
      refs,
    };
  }

  /**
   * The deal field of each order parameter: a custom field of deals named like it (case does not
   * matter), or whose name ends with that word («Заказ: Размер»); the exact name wins, then the shortest.
   * Two parameters never share a field.
   */
  private async paramTargets(dealId: number): Promise<Partial<Record<OrderParamKey, ParamTarget>>> {
    const fillers: { id: number; field: string }[] = await this.dataSource.query(`SELECT id, field FROM filler WHERE target = 'deal' ORDER BY id`);
    const values: { id: number; filler_id: number; value: string | null }[] = await this.dataSource.query(
      `SELECT id, filler_id, value FROM deal_filler WHERE deal_id = $1 ORDER BY id`,
      [dealId],
    );
    const norm = (s: string) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    const taken = new Set<number>();
    const out: Partial<Record<OrderParamKey, ParamTarget>> = {};
    for (const param of ORDER_PARAMS) {
      const names = param.fields.map((f) => f.toLowerCase());
      const free = fillers.filter((f) => !taken.has(Number(f.id)));
      const exact = free.find((f) => names.includes(norm(f.field)));
      const suffix = free
        .filter((f) => names.some((n) => norm(f.field).endsWith(` ${n}`) || norm(f.field).endsWith(`:${n}`)))
        .sort((a, b) => a.field.length - b.field.length)[0];
      const filler = exact ?? suffix;
      if (!filler) continue;
      taken.add(Number(filler.id));
      // a field may have more than one row (an old double save): the one with a value counts
      const rows = values.filter((v) => Number(v.filler_id) === Number(filler.id));
      const row = rows.find((v) => v.value && v.value.trim()) ?? rows[0];
      const current = row?.value && row.value.trim() ? row.value.trim() : null;
      out[param.key] = { filler_id: Number(filler.id), field: filler.field, deal_filler_id: row ? Number(row.id) : null, current };
    }
    return out;
  }

  /**
   * «Принять»: the parameters into their empty deal fields (DealService.update: the history of the deal
   * shows the change); a filled field keeps its value. Returns what was written with the ids of the
   * rows, so the open form of the deal shows them without a reload.
   */
  async accept(user: AuthUser, dealId: number, keys?: OrderParamKey[]): Promise<Record<string, any>> {
    if (!AI.turns) throw new ServiceUnavailableException('ИИ-разбор переписки выключен');
    const withMail = new Access(user).canReadMail;
    const params = await latestParams(this.dataSource, dealId, withMail);
    const targets = await this.paramTargets(dealId);
    const wanted = new Set<string>(keys?.length ? keys : params.map((p) => p.key));
    const accepted: { key: string; field: string; filler_id: number; value: string }[] = [];
    const kept: { key: string; field: string; value: string }[] = [];
    const unmapped: string[] = [];
    const missing: string[] = [];
    const fillers: { deal_filler_id: number; value: string }[] = [];
    const fillersCreate: { filler_id: number; value: string }[] = [];

    for (const key of wanted) {
      const param = params.find((p) => p.key === key);
      if (!param) {
        missing.push(key);
        continue;
      }
      const target = targets[param.key];
      if (!target) {
        unmapped.push(key);
        continue;
      }
      if (target.current) {
        kept.push({ key, field: target.field, value: target.current });
        continue;
      }
      const value = param.value.slice(0, 255);
      if (target.deal_filler_id) fillers.push({ deal_filler_id: target.deal_filler_id, value });
      else fillersCreate.push({ filler_id: target.filler_id, value });
      accepted.push({ key, field: target.field, filler_id: target.filler_id, value });
    }
    if (fillers.length || fillersCreate.length) {
      const data = { fillers, fillers_create: fillersCreate } as UpdateDealDto;
      await this.deals.update(dealId, { user } as any, data);
    }
    const rows: { id: number; filler_id: number; value: string }[] = accepted.length
      ? await this.dataSource.query(
          `SELECT id, filler_id, value FROM deal_filler WHERE deal_id = $1 AND filler_id = ANY($2) ORDER BY id`,
          [dealId, accepted.map((a) => a.filler_id)],
        )
      : [];
    this.tasks.changed(dealId);
    return {
      accepted: accepted.map((a) => {
        const row = rows.find((r) => Number(r.filler_id) === a.filler_id && r.value === a.value) ?? rows.find((r) => Number(r.filler_id) === a.filler_id);
        return { ...a, deal_filler_id: row ? Number(row.id) : null };
      }),
      kept,
      unmapped,
      missing,
    };
  }

  /** «Снять»: a question needs no answer / a promise is not needed; its task closes when nothing else holds it. */
  async dismiss(user: AuthUser, dealId: number, itemId: number): Promise<Record<string, any>> {
    if (!AI.turns) throw new ServiceUnavailableException('ИИ-разбор переписки выключен');
    const withMail = new Access(user).canReadMail;
    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE conversation_item SET status = 'dismissed', close_reason = 'dismissed', closed_at = now(), closed_by = $3
          WHERE id = $1 AND deal_id = $2 AND status = 'open' AND ($4::boolean OR NOT has_email)
          RETURNING id, kind, task_id`,
        [itemId, dealId, user.sub, withMail],
      ),
    );
    const item = rows[0];
    if (!item) throw new NotFoundException('Вопрос или обещание не найдено или уже закрыто');
    let taskClosed = false;
    if (item.task_id) {
      const by = await this.dataSource.getRepository(User).findOne({ where: { id: user.sub } });
      taskClosed = await this.tasks.closeIfDone(
        Number(item.task_id),
        item.kind === 'question' ? 'Снято менеджером: ответ не нужен' : 'Снято менеджером: обещание не нужно',
        by,
      );
    }
    this.tasks.changed(dealId);
    return { id: Number(item.id), status: 'dismissed', task_closed: taskClosed };
  }

  /** The bot tool deal_summary: the summary (made now if needed, the bot waits AI_BOT_WAIT_SEC) and what the analyses found. */
  async forBot(user: AuthUser, dealId: number): Promise<Record<string, any>> {
    const deal = await loadDeal(this.dataSource, dealId);
    if (!deal || !new Access(user).allowsDeal('view', deal.agent_id, deal.group_id)) {
      throw new NotFoundException('Сделка не найдена или нет доступа');
    }
    if (!AI.enabled) return { status: 'off', message: 'ИИ-функции CRM выключены администратором' };
    let state: SummaryState | null = null;
    let note: string | null = null;
    if (AI.summary) {
      try {
        state = await this.summaries.request(user, dealId, AI.botWaitSec * 1000);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const response: any = error.getResponse();
        note = typeof response === 'string' ? response : response?.message ?? error.message;
      }
    }
    const view = await this.view(user, dealId);
    const ready = state?.status === 'done';
    const base = (process.env.CRM_PUBLIC_URL || '').replace(/\/+$/, '');
    const at = (id: number | null) => (id && view.refs[id] ? localStamp(view.refs[id].at) : null);
    return {
      deal: { id: deal.id, number: deal.number, label: deal.label, ...(base ? { url: `${base}/deals/${deal.id}` } : {}) },
      summary_status: ready ? 'done' : state?.status ?? (AI.summary ? 'unavailable' : 'off'),
      summary: ready ? state.data : view.summary?.data ?? null,
      summary_is_current: ready,
      note:
        note ??
        (state && !ready
          ? state.status === 'empty'
            ? state.error
            : 'Свежая сводка ещё готовится, спросите ещё раз через минуту' + (view.summary?.data ? ' (выше — предыдущая)' : '')
          : null),
      open_questions: view.questions.map((q: any) => ({ text: q.text, asked_at: at(q.event_id) })),
      promises: view.promises.map((p: any) => ({ who: p.who, what: p.text, due: p.due })),
      order_params: view.order_params.map((p: any) => ({ name: p.label, value: p.value })),
      flags: view.flags.map((f: any) => f.label),
    };
  }
}
