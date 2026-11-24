import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { AiPriority } from '../ai/ai.config';
import { AiFormatError, AiJobRow, AiOutcome, AiQueueService, sha256 } from '../ai/ai-queue.service';
import { CHAT_EVENT_TYPES, loadDeal, messagesBefore, messagesByIds } from '../ai/ai-conversation';
import { loadStaffUser } from '../bot/bot-access';
import { AI2, PROMPT_VERSION_2, dayStart, localDay, minuteOfDay, testPrefixSql, weekday } from './ai-insights.config';
import { InsightsNotifier, dealScopeSql } from './insights-common';
import { CRITERION_LABEL, REVIEW_CRITERIA, REVIEW_SYSTEM, cleanReview, looksLikeReview, reviewPrompt } from './insights-prompts';

const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** the night pass ends at 07:00 */
const NIGHT_END = 7 * 60;

/**
 * «ИИ-супервайзер» (AI_SUPERVISOR): at night (AI_SUPERVISOR_AT .. 07:00) every dialog of the last
 * AI_SUPERVISOR_DAYS days — a deal with messages of the client and of the manager on one day (Telegram, WhatsApp,
 * e-mail) — is reviewed once against the checklist (приветствие, выявил потребность, ответил на все вопросы,
 * вежливость, предложил следующий шаг, грамотность) with scores and quotes, at most AI_SUPERVISOR_MAX a night
 * (background jobs "review", the priority of a nightly batch, within AI_DAILY_BUDGET) -> conversation_review.
 *  - «Качество диалогов» of the control page (GET /ai/quality): per employee the dialogs, the average score, the
 *    criteria and the main mistakes with «как сказать лучше». Advisory: not part of any rating.
 *  - Once a week (AI_SUPERVISOR_TIPS, AI_SUPERVISOR_TIPS_DAY at AI_SUPERVISOR_TIPS_AT) each employee who linked the
 *    bot gets «3 ошибки и как сказать лучше» from their reviews of the last 7 days (no AI call).
 */
@Injectable()
export class AiSupervisorService implements OnModuleInit {
  private readonly logger = new Logger('AiSupervisor');
  private plannedOn = '';
  private tipsOn = '';

  constructor(
    private dataSource: DataSource,
    private queue: AiQueueService,
    private notifier: InsightsNotifier,
  ) {}

  onModuleInit(): void {
    this.queue.register('review', (job) => this.run(job));
    this.queue.addTicker('supervisor', () => this.tick());
  }

  async tick(now = new Date()): Promise<number> {
    if (!AI2.supervisor) return 0;
    const today = localDay(now);
    const minute = minuteOfDay(now);
    let done = 0;
    // the night window may pass midnight (AI_SUPERVISOR_AT=23:00): from that time, or before 07:00
    const start = AI2.supervisorAt;
    const inNight = start < NIGHT_END ? minute >= start && minute < NIGHT_END : minute >= start || minute < NIGHT_END;
    if (inNight && this.plannedOn !== today) {
      done += (await this.plan(now)).queued;
      this.plannedOn = today;
    }
    if (AI2.tips && this.tipsOn !== today && weekday(now) === AI2.tipsDay && minute >= AI2.tipsAt && minute < AI2.tipsAt + 180) {
      done += await this.sendTips(now);
      this.tipsOn = today;
    }
    return done;
  }

  // ------------------------------------------------------------------ planning

  /**
   * Queues the reviews of the dialogs of the past days not reviewed yet (today is not over: never today), newest
   * day first, at most AI_SUPERVISOR_MAX a night (the jobs queued since the night started count). By hand (admin):
   * `days` / `dealIds` narrow it.
   */
  async plan(now = new Date(), opts: { days?: string[]; dealIds?: number[]; max?: number } = {}): Promise<{ queued: number; found: number }> {
    if (!AI2.supervisor) return { queued: 0, found: 0 };
    const today = dayStart(localDay(now));
    const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - AI2.supervisorDays);
    // the night started at AI_SUPERVISOR_AT (yesterday's, when it is past midnight now and the time is in the evening)
    const nightStart = new Date(today.getTime() + AI2.supervisorAt * 60_000);
    if (nightStart > now) nightStart.setDate(nightStart.getDate() - 1);
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM ai_job WHERE kind = 'review' AND created_at >= $1`, [nightStart]);
    const left = Math.max(0, Math.min(opts.max ?? AI2.supervisorMax, AI2.supervisorMax) - (opts.dealIds ? 0 : Number(n)));
    if (left <= 0) return { queued: 0, found: 0 };

    const params: unknown[] = [CHAT_EVENT_TYPES, since, today];
    const prefix = testPrefixSql(params, 'd');
    const extra: string[] = [];
    if (opts.days?.length) {
      params.push(opts.days.filter((d) => PLAIN_DAY.test(d)));
      extra.push(`AND x.day = ANY($${params.length}::date[])`);
    }
    if (opts.dealIds?.length) {
      params.push(opts.dealIds);
      extra.push(`AND x.deal_id = ANY($${params.length}::int[])`);
    }
    params.push(left);
    const dialogs: { deal_id: number; day: string; ids: number[]; agent_id: number | null }[] = await this.dataSource.query(
      `SELECT x.deal_id, to_char(x.day, 'YYYY-MM-DD') AS day, x.ids,
              COALESCE((SELECT e.user_id FROM event e JOIN "user" u ON u.id = e.user_id AND u.role IN ('admin', 'manager', 'agent')
                         WHERE e.id = ANY(x.ids) AND e.outgoing GROUP BY e.user_id ORDER BY count(*) DESC, e.user_id LIMIT 1), x.agent_id) AS agent_id
         FROM (
           SELECT e.deal_id, e.created_at::date AS day, d.agent_id,
                  (array_agg(e.id ORDER BY e.created_at, e.id))[1:60] AS ids,
                  count(*) FILTER (WHERE NOT e.outgoing) AS client_n, count(*) FILTER (WHERE e.outgoing) AS manager_n
             FROM event e JOIN deal d ON d.id = e.deal_id AND d.deleted_at IS NULL ${prefix}
            WHERE e.type = ANY($1) AND e.created_at >= $2 AND e.created_at < $3
            GROUP BY e.deal_id, e.created_at::date, d.agent_id
         ) x
        WHERE x.client_n > 0 AND x.manager_n > 0 ${extra.join(' ')}
          AND NOT EXISTS (SELECT 1 FROM conversation_review r WHERE r.deal_id = x.deal_id AND r.day = x.day)
          AND NOT EXISTS (SELECT 1 FROM ai_job j WHERE j.kind = 'review' AND j.entity = 'deal' AND j.entity_id = x.deal_id
                                                   AND j.input->>'day' = to_char(x.day, 'YYYY-MM-DD') AND j.status IN ('queued', 'running'))
        ORDER BY x.day DESC, x.deal_id
        LIMIT $${params.length}`,
      params,
    );
    let queued = 0;
    for (const dialog of dialogs) {
      const ids = (dialog.ids ?? []).map(Number);
      const { created } = await this.queue.enqueue({
        kind: 'review',
        entity: 'deal',
        entityId: Number(dialog.deal_id),
        inputHash: sha256({ v: PROMPT_VERSION_2.review, deal: Number(dialog.deal_id), day: dialog.day, events: ids }),
        input: { deal_id: Number(dialog.deal_id), day: dialog.day, event_ids: ids, agent_id: dialog.agent_id === null ? null : Number(dialog.agent_id) },
        priority: AiPriority.NIGHTLY,
        promptVersion: PROMPT_VERSION_2.review,
      });
      if (created) queued++;
    }
    if (queued) this.logger.log(`supervisor: ${queued} dialog(s) queued for review`);
    return { queued, found: dialogs.length };
  }

  private async run(job: AiJobRow): Promise<AiOutcome> {
    const dealId = job.entity_id;
    const day = String(job.input?.day ?? '');
    const deal = await loadDeal(this.dataSource, dealId);
    if (!deal) return { skipped: 'сделка удалена' };
    const messages = await messagesByIds(this.dataSource, dealId, job.input?.event_ids ?? [], 1200);
    if (!messages.some((m) => m.from === 'manager') || !messages.some((m) => m.from === 'client')) {
      return { skipped: 'в этот день нет переписки менеджера с клиентом' };
    }
    const context = await messagesBefore(this.dataSource, dealId, messages[0], 6, 500);
    const raw = await this.queue.askJson(job, REVIEW_SYSTEM, reviewPrompt({ now: new Date(), day, deal, context, messages }));
    if (!looksLikeReview(raw)) throw new AiFormatError('ИИ ответил не по формату разбора диалога');
    const review = cleanReview(raw, messages);
    const channels = [...new Set(messages.map((m) => m.channel))];
    await this.dataSource.query(
      `INSERT INTO conversation_review (deal_id, day, agent_id, job_id, from_event_id, to_event_id, channels, has_email, messages,
                                        scores, score, mistakes, summary, prompt_version)
       SELECT $1, $2::date, u.id, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14
         FROM (SELECT $3::int AS wanted) w LEFT JOIN "user" u ON u.id = w.wanted AND u.deleted_at IS NULL
       ON CONFLICT (deal_id, day) DO NOTHING`,
      [
        dealId,
        day,
        job.input?.agent_id ?? deal.agent_id ?? null,
        job.id,
        messages[0].id,
        Math.max(...messages.map((m) => m.id)),
        channels.join(',').slice(0, 64),
        channels.includes('email'),
        Math.min(messages.length, 32000),
        JSON.stringify(review.scores),
        review.score,
        JSON.stringify(review.mistakes),
        review.summary || null,
        job.prompt_version,
      ],
    );
    return { result: { ...review } };
  }

  // ------------------------------------------------------------------ «Качество диалогов»

  /** GET /ai/quality: per employee the reviewed dialogs of the period (the deals the reader may see). */
  async quality(user: AuthUser, q: { from_date?: string; till_date?: string }): Promise<Record<string, any>> {
    const access = new Access(user);
    const now = new Date();
    const fromDay = q.from_date && PLAIN_DAY.test(q.from_date) ? q.from_date : localDay(new Date(now.getFullYear(), now.getMonth(), 1));
    const tillDay = q.till_date && PLAIN_DAY.test(q.till_date) ? q.till_date : localDay(now);
    const params: unknown[] = [fromDay, tillDay, access.canReadMail];
    const scope = dealScopeSql(access, params, 'd');
    const rows: any[] = await this.dataSource.query(
      `SELECT r.id, r.deal_id, to_char(r.day, 'YYYY-MM-DD') AS day, r.agent_id, a.username AS agent, r.scores, r.score, r.mistakes, r.summary,
              r.has_email, r.messages, d.display_id, d.label AS deal_label
         FROM conversation_review r
         JOIN deal d ON d.id = r.deal_id AND d.deleted_at IS NULL
         LEFT JOIN "user" a ON a.id = r.agent_id
        WHERE r.day >= $1::date AND r.day <= $2::date AND ($3::boolean OR NOT r.has_email) AND ${scope}
        ORDER BY r.day DESC, r.id DESC LIMIT 2000`,
      params,
    );
    const byAgent = new Map<number, any>();
    for (const r of rows) {
      const id = r.agent_id === null ? 0 : Number(r.agent_id);
      let a = byAgent.get(id);
      if (!a) {
        a = { id, name: r.agent ?? 'Без ответственного', dialogs: 0, scored: [] as number[], criteria: {} as Record<string, number[]>, mistakes: [] as any[] };
        byAgent.set(id, a);
      }
      a.dialogs++;
      if (r.score !== null) a.scored.push(Number(r.score));
      for (const c of REVIEW_CRITERIA) {
        const v = r.scores?.[c.key];
        if (v === 0 || v === 1 || v === 2) (a.criteria[c.key] ??= []).push(v);
      }
      for (const m of Array.isArray(r.mistakes) ? r.mistakes : []) {
        a.mistakes.push({
          deal: { id: Number(r.deal_id), number: r.display_id === null ? null : Number(r.display_id), label: r.deal_label },
          day: r.day,
          score: r.score,
          criterion: m.criterion,
          criterion_label: CRITERION_LABEL[m.criterion] ?? m.criterion,
          quote: m.quote,
          better: m.better,
        });
      }
    }
    const pct = (values: number[]) => (values.length ? Math.round((values.reduce((s, v) => s + v, 0) / (values.length * 2)) * 100) : null);
    const agents = [...byAgent.values()]
      .map((a) => {
        const criteria = Object.fromEntries(REVIEW_CRITERIA.map((c) => [c.key, pct(a.criteria[c.key] ?? [])]));
        const weakest = REVIEW_CRITERIA.map((c) => ({ key: c.key, value: criteria[c.key] as number | null }))
          .filter((c) => c.value !== null)
          .sort((x, y) => (x.value as number) - (y.value as number))[0];
        // the main mistakes: of the dialogs with the lowest scores, one per criterion first
        const sorted = [...a.mistakes].sort((x, y) => (x.score ?? 100) - (y.score ?? 100));
        const picked: any[] = [];
        for (const m of sorted) if (!picked.some((p) => p.criterion === m.criterion)) picked.push(m);
        for (const m of sorted) if (picked.length < 3 && !picked.includes(m)) picked.push(m);
        return {
          id: a.id,
          name: a.name,
          dialogs: a.dialogs,
          score: a.scored.length ? Math.round(a.scored.reduce((s: number, v: number) => s + v, 0) / a.scored.length) : null,
          criteria,
          weakest: weakest ? { key: weakest.key, label: CRITERION_LABEL[weakest.key], value: weakest.value } : null,
          mistakes: picked.slice(0, 3),
          mistakes_total: a.mistakes.length,
        };
      })
      .sort((x, y) => y.dialogs - x.dialogs);
    const [{ queued }] = await this.dataSource.query(`SELECT count(*)::int AS queued FROM ai_job WHERE kind = 'review' AND status IN ('queued', 'running')`);
    return {
      enabled: AI2.supervisor,
      advisory: true,
      note: 'Рекомендации ИИ: на оценки, рейтинги и премии не влияют',
      period: { from: fromDay, till: tillDay },
      criteria: REVIEW_CRITERIA.map((c) => ({ key: c.key, label: c.label })),
      total: {
        dialogs: rows.length,
        score: (() => {
          const scored = rows.filter((r) => r.score !== null).map((r) => Number(r.score));
          return scored.length ? Math.round(scored.reduce((s, v) => s + v, 0) / scored.length) : null;
        })(),
      },
      agents,
      queued: Number(queued),
    };
  }

  // ------------------------------------------------------------------ weekly tips

  /** «3 ошибки и как сказать лучше» of the last 7 days to each employee who linked the bot (or these). */
  async sendTips(now = new Date(), userIds?: number[]): Promise<number> {
    if (!AI2.tips) return 0;
    const day = localDay(now);
    const since = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));
    let sent = 0;
    for (const chat of await this.notifier.chats(userIds ? { userIds } : {})) {
      try {
        const user = await loadStaffUser(this.dataSource, chat.user_id);
        if (!user) continue;
        const withMail = new Access(user).canReadMail;
        const reviews: any[] = await this.dataSource.query(
          `SELECT r.score, r.mistakes, d.display_id FROM conversation_review r JOIN deal d ON d.id = r.deal_id AND d.deleted_at IS NULL
            WHERE r.agent_id = $1 AND r.day >= $2::date AND r.day < $3::date AND ($4::boolean OR NOT r.has_email)
            ORDER BY r.score NULLS LAST, r.id`,
          [chat.user_id, since, day, withMail],
        );
        const mistakes: any[] = [];
        for (const r of reviews) for (const m of Array.isArray(r.mistakes) ? r.mistakes : []) mistakes.push({ ...m, number: r.display_id });
        if (!mistakes.length) continue;
        const picked: any[] = [];
        for (const m of mistakes) if (picked.length < 3 && !picked.some((p) => p.criterion === m.criterion)) picked.push(m);
        for (const m of mistakes) if (picked.length < 3 && !picked.includes(m)) picked.push(m);
        const scored = reviews.filter((r) => r.score !== null).map((r) => Number(r.score));
        const lines = [
          'Разбор вашей переписки за неделю — подсказки ИИ, на оценки не влияют.',
          `Диалогов разобрано: ${reviews.length}${scored.length ? `, в среднем ${Math.round(scored.reduce((s, v) => s + v, 0) / scored.length)}%` : ''}.`,
          '',
          `${picked.length === 1 ? 'Ошибка' : `${picked.length} ошибки`} и как сказать лучше:`,
        ];
        picked.forEach((m, i) => {
          lines.push(`${i + 1}. ${CRITERION_LABEL[m.criterion] ?? m.criterion}${m.number ? ` (сделка №${m.number})` : ''}: вы написали «${m.quote}».`);
          lines.push(`   Лучше: «${m.better}»`);
        });
        if (await this.notifier.sendOnce('tips', chat, day, lines.join('\n'))) sent++;
      } catch (error) {
        this.logger.warn(`tips for user ${chat.user_id}: ${(error as Error).message}`);
      }
    }
    if (sent) this.logger.log(`weekly tips: ${sent} sent`);
    return sent;
  }
}

